import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { scan, partialCurveDetections, headlessCurveDetections } from '../src/index.js';
import { classifyRegions } from '../src/regions.js';
import { scanPrefixedAxes } from '../src/pool.js';
import { poolStructuralActive } from '../src/structural.js';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import { canonDigest } from './canon.js';

/**
 * Phase-3 two-pass wiring (spike docs/notes/ms41-p3-partial-curves-spike.md):
 * scan() runs the partial 1D-curve discriminator ONLY on poolStructuralActive
 * bins, re-emitting through rankAndEmit's curve tier when it finds anything.
 */

const cfg = DEFAULT_SCAN_CONFIG;
const isCurveShaped = (m: MapDef): boolean => (m.rows === 1) !== (m.cols === 1);
const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../fixtures/synthetic/${name}.bin`, import.meta.url)));

describe('scan() two-pass partial-curve emission', () => {
  it('emits a planted tiled curve on a gate-active partial (N×1, detector structural)', { timeout: 60_000 }, () => {
    // Start from the committed gate-active partial (poolStructuralActive is
    // TRUE on it — asserted below) and plant a curve block right after the
    // LAST structural emission's end: a trusted edge with free noise after it.
    const bytes = fixtureBytes('synth-partial-201');
    const prefixed = scanPrefixedAxes(bytes, classifyRegions(bytes, cfg), cfg);
    expect(poolStructuralActive(bytes, prefixed, cfg)).toBe(true);

    const base = scan(bytes, cfg).potentialMaps;
    const structural = base.filter((m) => m.detector === 'structural');
    expect(structural.length).toBeGreaterThan(0);
    const last = structural.reduce((a, b) =>
      a.address + a.rows * a.cols * a.format.width >= b.address + b.rows * b.cols * b.format.width ? a : b
    );
    const edge = last.address + last.rows * last.cols * last.format.width;

    // axis to point at: a maximal pooled axis (its count prefix sits one byte
    // before its data start — u8 pool axes in this fixture family)
    const axis = prefixed.filter((a) => a.maximal && a.format.width === 1)[0]!;
    const ptr = axis.address - 1;

    const planted = new Uint8Array(bytes); // copy — never mutate the fixture
    expect(edge + 2 + axis.count).toBeLessThan(planted.length);
    planted[edge] = ptr & 0xff;
    planted[edge + 1] = (ptr >> 8) & 0xff;
    for (let i = 0; i < axis.count; i++) planted[edge + 2 + i] = 200 + (i % 3);

    const out = scan(planted, cfg).potentialMaps;
    const curve = out.find((m) => m.address === edge + 2);
    expect(curve).toBeDefined();
    expect(curve!.rows).toBe(axis.count);
    expect(curve!.cols).toBe(1);
    expect(curve!.detector).toBe('structural');
    expect(curve!.yAxis?.address).toBe(axis.address);
  });

  for (const name of ['synth-partial-201', 'synth-partial-203'] as const) {
    it(`${name} matches pinned detections and exact table frames with zero curve-shaped maps`, { timeout: 60_000 }, () => {
      const pinned = {
        'synth-partial-201': {
          count: 63,
          digest: 'd29994e1728fdabaaf8ebd020033b0e4a658da83e024d8a97afdd881bbfa30d6',
        },
        'synth-partial-203': {
          count: 63,
          digest: '81cfe73529bb7f5e9d41302f93b2ce24440e5ee593d21c3cb2dd1acd2d7e31d4',
        },
      }[name];
      const maps = scan(fixtureBytes(name), cfg).potentialMaps;
      expect(canonDigest(maps)).toEqual(pinned);
      expect(maps.filter(isCurveShaped)).toHaveLength(0);
      const truth = JSON.parse(readFileSync(new URL(`../../../fixtures/synthetic/${name}.groundtruth.json`, import.meta.url), 'utf8')) as { maps: MapDef[] };
      expect(truth.maps.length).toBeGreaterThan(0);
      for (const t of truth.maps) {
        expect(maps).toContainEqual(expect.objectContaining({ address: t.address, rows: t.rows, cols: t.cols, format: t.format }));
      }
    });
  }

  it('a full-read-sized buffer never runs the detector (would-pass adjax layout, no 1d emission)', () => {
    // [n][axis][hdr][data] — the self-anchoring layout the discriminator
    // accepts with NO other structure (proven in partial-curves.test.ts (d)).
    // In a >= STRUCT_MAX_BIN_LEN buffer the size ceiling keeps the gate off,
    // so scan() must emit no curve-shaped map: the only way this layout could
    // emit 1×N is through the partial-curve channel.
    const b = new Uint8Array(0x18000);
    b[0x180] = 6;
    for (let i = 0; i < 6; i++) b[0x181 + i] = 10 + i * 11;
    b[0x187] = 0x80;
    b[0x188] = 0x01; // ptr 0x180
    for (let i = 0; i < 6; i++) b[0x189 + i] = 200 + (i % 3);
    // sanity: the discriminator WOULD pass it if invoked directly
    expect(partialCurveDetections(b, [], [], cfg).length).toBe(1);
    const maps = scan(b, cfg).potentialMaps;
    expect(maps.filter(isCurveShaped)).toHaveLength(0);
  });

  it('emits a planted HEADERLESS sandwich curve on a gate-active partial (tier 8, S1 overlay)', { timeout: 60_000 }, () => {
    // S1 needs a TRUSTED start axis and a trusted end edge around a strictly
    // free block. Planted axes are only trusted if scanPrefixedAxes finds
    // them MAXIMAL inside a 'data' region — so plant the FULL sandwich
    // [X axis][block][Y axis] into a clear data-region gap that no trusted
    // span touches. (Measured at plan time on 201: no free window exists
    // AFTER any existing pooled axis — the pool is packed back-to-back — but
    // clear data gaps DO exist, largest 64B @0x5FC0, and axes planted there
    // ARE found maximal; the full pipeline emits E with detector
    // 'structural' / confidence 0.4 / yAxis = X's data address.)
    // NO backward header anywhere — invisible to the tier-7 sweep. Do NOT
    // add exact-count assertions on the planted buffer: the plant also
    // yields 2 faithful junk detections (a rev before X, a fwd after Y).
    const bytes = fixtureBytes('synth-partial-201');
    const regions = classifyRegions(bytes, cfg);
    const prefixed = scanPrefixedAxes(bytes, regions, cfg);
    expect(poolStructuralActive(bytes, prefixed, cfg)).toBe(true);

    const base = scan(bytes, cfg).potentialMaps;
    const occupied: Array<[number, number]> = [
      ...base.map((m): [number, number] => [m.address - 4, m.address + m.rows * m.cols * m.format.width]),
      ...prefixed.map((a): [number, number] => [a.address - a.format.width, a.end]),
    ];
    const clear = (s: number, e: number): boolean => !occupied.some(([a, b]) => a < e && s < b);
    // layout: guard(1) + [6][X cells](7) + block(6) + [6][Y cells](7) + breaker(1) = 22 bytes
    let g0 = -1;
    let gLen = 0;
    for (const r of regions) {
      if (r.kind !== 'data') continue;
      const end = Math.min(r.end, 0x6000);
      let s = r.start;
      while (s < end) {
        let e = s;
        while (e < end && clear(e, e + 1)) e++;
        if (e - s > gLen) { g0 = s; gLen = e - s; }
        s = e + 1;
      }
    }
    expect(gLen).toBeGreaterThanOrEqual(22); // measured: 64B @0x5FC0 (also 42B @0x17C0)

    const xData = g0 + 2; // 1 guard byte, then [6] prefix, then cells
    const E = xData + 6; // block start = X's axis end
    const planted = new Uint8Array(bytes); // copy — never mutate the fixture
    planted[g0 + 1] = 6;
    for (let i = 0; i < 6; i++) planted[xData + i] = 10 + i * 13; // X: strictly ascending
    planted[E] = 0; // block byte 0: breaks X's ascent (keeps it maximal), can't parse or point
    for (let i = 1; i < 6; i++) planted[E + i] = 200 + (i % 3);
    planted[E + 6] = 6; // Y: [6][50,61,72,83,94,105] — its span START closes the sandwich
    for (let i = 0; i < 6; i++) planted[E + 7 + i] = 50 + i * 11;
    planted[E + 13] = 0; // trend breaker keeps Y maximal

    const out = scan(planted, cfg).potentialMaps;
    const curve = out.find((m) => m.address === E);
    expect(curve).toBeDefined();
    expect(curve!.rows).toBe(6);
    expect(curve!.cols).toBe(1);
    expect(curve!.detector).toBe('structural');
    // tier-8 identity: the headless confidence, NOT curvePartialConfidence
    expect(curve!.confidence).toBe(cfg.pool.curveHeadlessConfidence);
    expect(curve!.yAxis?.address).toBe(xData);
  });

  it('a full-read-sized buffer never runs the HEADERLESS overlay (would-pass sandwich, no 1d emission)', () => {
    // Sandwich below CURVE_PARTIAL_END that the overlay accepts when handed
    // trusted spans directly — in a >= STRUCT_MAX_BIN_LEN buffer the size
    // ceiling keeps the gate off, so scan() must emit no curve-shaped map.
    const b = new Uint8Array(0x18000);
    b[0x180] = 6;
    for (let i = 0; i < 6; i++) b[0x181 + i] = 10 + i * 11;
    for (let i = 0; i < 6; i++) b[0x187 + i] = 200 + (i % 3);
    b[0x18d] = 4;
    for (let i = 0; i < 4; i++) b[0x18e + i] = 50 + i * 23;
    const paxU8 = (address: number, count: number) => ({
      address, count, format: { width: 1, signed: false, endianness: 'big' } as const,
      end: address + count, maximal: true,
    });
    // sanity: the overlay WOULD emit it if invoked directly
    expect(
      headlessCurveDetections(b, [], [paxU8(0x181, 6), paxU8(0x18e, 4)], cfg).some((d) => d.address === 0x187)
    ).toBe(true);
    const maps = scan(b, cfg).potentialMaps;
    expect(maps.filter(isCurveShaped)).toHaveLength(0);
  });

  for (const name of ['synth-pcurve-401', 'synth-pcurve-403'] as const) {
    it(`${name} through scan() stays byte-identical (pre-P3.1 canon)`, { timeout: 60_000 }, () => {
      // Real-overlap-semantics gate: full scan()/rankAndEmit output pinned,
      // not the spike's any-overlap static predictor (skeptic condition).
      const pinned = {
        'synth-pcurve-401': { count: 83, digest: 'ec1643fe0fcddd5169ba3eeaf248fac19e509513f8eb960094989275247c62ae' },
        'synth-pcurve-403': { count: 83, digest: '2251305b2299c3c534489ee74f4678e3caa6eb14a1e3fde2f27a3b1b55c02f28' },
      }[name];
      expect(canonDigest(scan(fixtureBytes(name), cfg).potentialMaps)).toEqual(pinned);
    });
  }
});
