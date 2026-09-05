import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ValueFormat } from '@binanalyzer/core';
import { headlessCurveDetections } from '../src/partial-curves.js';
import { classifyRegions } from '../src/regions.js';
import { scanPrefixedAxes, type PrefixedAxis } from '../src/pool.js';
import { scan } from '../src/index.js';
import { DEFAULT_SCAN_CONFIG, type ScanConfig } from '../src/config.js';

/**
 * P3.1-S1 headerless overlay (spike docs/notes/ms41-p31-headerless-spike.md,
 * transcribed from the measured acceptance algorithm). Component tests craft
 * minimal buffers; junk-suppression bytes (far pointers / parse blockers) are
 * REQUIRED scaffolding — the discriminator is deliberately junk-permissive
 * (25% emission precision on real bins) and chained artifacts are real
 * behavior, not bugs. Every extra byte below is annotated with what it kills.
 */

const cfg = DEFAULT_SCAN_CONFIG;
const u8fmt: ValueFormat = { width: 1, signed: false, endianness: 'big' };

/** [n][cells...] strictly-increasing u8 axis at `prefix`; returns data address. */
function putAxis(b: Uint8Array, prefix: number, count: number, start = 10, step = 11): number {
  b[prefix] = count;
  for (let i = 0; i < count; i++) b[prefix + 1 + i] = start + i * step;
  return prefix + 1;
}
/** Raw non-axis-parsing block data (first byte 200 → count 200 > axis.maxCount). */
function putData(b: Uint8Array, s: number, len: number): void {
  for (let i = 0; i < len; i++) b[s + i] = 200 + (i % 3);
}
/** Far 2-byte LE pointer at `at` pointing to `ptr` — creates a tier-7 sweep
 *  candidate referencing that axis, which suppresses the axis's REV headerless
 *  candidate (sweepRefAxes rule). */
function putFarRef(b: Uint8Array, at: number, ptr: number): void {
  b[at] = ptr & 0xff;
  b[at + 1] = (ptr >> 8) & 0xff;
}
/** Parse blocker: a tiny count-prefixed monotone run at `at` — makes a FWD
 *  candidate starting at `at` parse-veto out. */
function putParseBlocker(b: Uint8Array, at: number): void {
  b[at] = 2;
  b[at + 1] = 10;
  b[at + 2] = 20;
}
const pax = (address: number, count: number): PrefixedAxis => ({
  address, count, format: u8fmt, end: address + count * u8fmt.width, maximal: true,
});

/** The (a) sandwich: X(n=6)@0x100 | block[0x107,0x10D) | Y(n=4)@0x10D.
 *  Suppression: far refs at 0x200/0x210 kill X's and Y's rev candidates
 *  (load-bearing — without the 0x200 ref, X's rev unions into the anchored
 *  component and emits junk at 0xFA); the parse blocker at 0x112 kills Y's
 *  fwd candidate (defense-in-depth — it would also fail end-anchoring). */
function sandwich(): { b: Uint8Array; xData: number; p: number } {
  const b = new Uint8Array(0x400);
  const xData = putAxis(b, 0x100, 6);
  putData(b, 0x107, 6);
  putAxis(b, 0x10d, 4, 50, 23);
  putParseBlocker(b, 0x112);
  putFarRef(b, 0x200, 0x100);
  putFarRef(b, 0x210, 0x10d);
  return { b, xData, p: 0x107 };
}
const sandwichPrefixed = (): PrefixedAxis[] => [pax(0x101, 6), pax(0x10e, 4)];

describe('headlessCurveDetections — S1 component tests', () => {
  it('(a) fwd sandwich: trusted axis end → free block → trusted span start emits ONE tier-8 1d detection', () => {
    const { b, xData, p } = sandwich();
    const out = headlessCurveDetections(b, [], sandwichPrefixed(), cfg);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      address: p, rows: 6, cols: 1, tier: 8, kind: '1d',
      score: cfg.pool.curveHeadlessConfidence,
      yAxis: { address: xData, count: 6 },
    });
    expect(out[0]!.format.width).toBe(1); // w1: exact end-packing on the trusted edge
  });

  it('(b) parse-veto: block data that itself parses as a count-prefixed monotone axis is killed — at floor 2 REGARDLESS of the candidate knob', () => {
    const { b } = sandwich();
    // overwrite the block with an axis-looking run: [3][10,20,30] then padding
    b[0x107] = 3; b[0x108] = 10; b[0x109] = 20; b[0x10a] = 30; b[0x10b] = 0; b[0x10c] = 0;
    expect(headlessCurveDetections(b, [], sandwichPrefixed(), cfg)).toHaveLength(0);
    // candidate floor raised to 4: the count-3 parse must STILL veto (floor is
    // the structural const 2, not the knob — measured inversion in the spike)
    const cfg4: ScanConfig = { ...cfg, pool: { ...cfg.pool, curveHeadlessMinCount: 4 } };
    expect(headlessCurveDetections(b, [], sandwichPrefixed(), cfg4)).toHaveLength(0);
  });

  it('(c) rev recovery with per-axis width DEDUP: both widths strictly free, only the smallest emits', () => {
    const b = new Uint8Array(0x400);
    // Z(n=4)@0x180 with NOTHING before it for 8+ bytes: BOTH rev twin blocks
    // are strictly free (w1 [0x17C,0x180), w2 [0x178,0x180)) — the geometry
    // that actually exercises the dedup break (a span-abutting start anchor
    // would blockFree-veto the w2 twin by itself and prove nothing).
    // Anchoring comes from Z's OWN fwd candidate in the same union component:
    // fwd pS contains ax.ptr 0x180 (= Z's span start, an edge) → compS; the
    // rev node's end 0x180 unions with it and is itself an edge → compE.
    putAxis(b, 0x180, 4);
    const out = headlessCurveDetections(b, [], [pax(0x181, 4)], cfg);
    // correct: rev w1 @0x17C + the incidental fwd @0x185 (zeros block, same
    // component). A break-less (dedup-missing) implementation ALSO emits the
    // w2 twin @0x178 — the exact-set assertion catches it.
    expect(out.map((d) => d.address).sort((x, y) => x - y)).toEqual([0x17c, 0x185]);
    const rev = out.find((d) => d.address === 0x17c)!;
    expect(rev).toMatchObject({ rows: 4, cols: 1, tier: 8 });
    expect(rev.format.width).toBe(1);
    expect(out.some((d) => d.address === 0x178)).toBe(false);
  });

  it('(c2) rev is skipped entirely when the axis is referenced by ANY sweep candidate', () => {
    const b = new Uint8Array(0x400);
    putAxis(b, 0x180, 4);
    putFarRef(b, 0x230, 0x180); // sweep candidate references Z → rev suppressed
    const out = headlessCurveDetections(b, [], [pax(0x181, 4)], cfg);
    // without the rev node, the fwd candidate loses its compE partner → nothing
    expect(out).toHaveLength(0);
  });

  it('(d) own-adjax skip: the [n][axis][hdr][data] sweep layout is tier-7 territory, not headerless', () => {
    const b = new Uint8Array(0x400);
    putAxis(b, 0x100, 6);
    // block starts with a header pointing at the axis prefix → ownAdjax.
    // The end-anchor axis Y sits at the HEADERLESS block end 0x10D
    // (= 0x107 + n, header bytes INSIDE the block): with the ownAdjax check
    // removed, the fwd candidate is sandwich-closed (start 0x107 = X span
    // end, end 0x10D = Y span start) and WOULD emit — the zero-assertion is
    // load-bearing against the rule's removal.
    putFarRef(b, 0x107, 0x100);
    putData(b, 0x109, 4); // header(2) + data(4) = 6 bytes = the n=6 block [0x107, 0x10D)
    putAxis(b, 0x10d, 4, 50, 23);
    putParseBlocker(b, 0x112); // kills Y's fwd candidate
    putFarRef(b, 0x210, 0x10d); // kills Y's rev candidate
    // (X's rev is auto-suppressed: the 0x107 header IS a sweep ref to 0x100)
    const out = headlessCurveDetections(b, [], [pax(0x101, 6), pax(0x10e, 4)], cfg);
    expect(out).toHaveLength(0);
  });

  it('(e) STRICTLY-free blocks: a pool span overlapping the block from before (the tier-7 F-ptrim excuse) vetoes here', () => {
    const { b } = sandwich();
    // extra trusted pool span [0x105, 0x10A) overlapping the block [0x107, 0x10D)
    const prefixed = [...sandwichPrefixed(), pax(0x106, 4)];
    const out = headlessCurveDetections(b, [], prefixed, cfg);
    expect(out.some((d) => d.address === 0x107)).toBe(false);
  });

  it('(f) untrusted axis: a textbook sandwich whose axis is not a trusted span emits nothing', () => {
    const { b } = sandwich();
    // X's pool span withheld → not trusted (Y kept so its edges still exist)
    const out = headlessCurveDetections(b, [], [pax(0x10e, 4)], cfg);
    expect(out).toHaveLength(0);
  });

  it('(g) single-sided is DEAD: start-anchored but open-ended emits nothing', () => {
    const { b } = sandwich();
    b[0x10d] = 0; b[0x10e] = 0; b[0x10f] = 0; b[0x110] = 0; b[0x111] = 0; // remove Y's bytes
    const out = headlessCurveDetections(b, [], [pax(0x101, 6)], cfg); // Y's span withheld too
    expect(out).toHaveLength(0);
  });
});

describe('headlessCurveDetections — fixture inertness pins (spike-measured ZERO; the synth gate)', () => {
  // Input shape matches the spike's synth-gate harness: full scan() output +
  // prefixed axes. Equivalent to first-pass maps0 here — 1d emissions carry
  // detector 'structural' but their cols-1 spans unconditionally demote under
  // gridLegit (skeptic-verified), and 201/203 have no 1d emissions at all.
  for (const name of ['synth-partial-201', 'synth-partial-203', 'synth-pcurve-401', 'synth-pcurve-403'] as const) {
    it(`${name}: ZERO headerless detections`, { timeout: 60_000 }, () => {
      const bytes = new Uint8Array(
        readFileSync(new URL(`../../../fixtures/synthetic/${name}.bin`, import.meta.url))
      );
      const maps = scan(bytes, cfg).potentialMaps;
      const prefixed = scanPrefixedAxes(bytes, classifyRegions(bytes, cfg), cfg);
      expect(headlessCurveDetections(bytes, maps, prefixed, cfg)).toHaveLength(0);
    });
  }
});
