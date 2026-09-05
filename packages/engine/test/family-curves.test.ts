import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import type { ReaderCall } from '../src/family/ms41/c166.js';
import {
  CURVE_ADJ_TIER,
  CURVE_FALLBACK_TIER,
  CURVE_TIER,
  detectMs41CurveFallbacks,
  detectMs41Curves,
} from '../src/family/ms41/curves.js';
import { saToFo } from '../src/family/ms41/frame.js';

function putSA(bytes: Uint8Array, sa: number, vals: number[]): void {
  for (let i = 0; i < vals.length; i++) bytes[saToFo(sa + i)] = vals[i]!;
}

const call = (targetCpu: number, sa: number): ReaderCall => ({ siteFile: 0, targetCpu, sa, dist: 0 });

const FALLBACK_TARGET = 0x1200;

/**
 * A single curve-reader arg SA whose backward 2-byte header points at a
 * strictly-monotone count-prefixed axis run of `count` u8 cells. `readers`
 * maps FALLBACK_TARGET directly (no self-location needed for these tests).
 */
function craftHeaderCurve({ count }: { count: number }): {
  bytes: Uint8Array;
  calls: ReaderCall[];
  readers: Map<number, 1 | 2>;
  sa: number;
} {
  const bytes = new Uint8Array(0x18000);
  const p = 0x150; // backward axis SA (count prefix)
  const sa = 0x300; // curve-reader arg SA
  const cells = Array.from({ length: count }, (_, i) => i + 1); // strictly increasing
  putSA(bytes, p, [count, ...cells]);
  putSA(bytes, sa - 2, [p & 0xff, (p >> 8) & 0xff]); // [sa-2] = LE(p), backward
  const calls: ReaderCall[] = [call(FALLBACK_TARGET, sa)];
  const readers = new Map<number, 1 | 2>([[FALLBACK_TARGET, 1]]);
  return { bytes, calls, readers, sa };
}

describe('detectMs41Curves', () => {
  it('emits one N×1 tier-CURVE_TIER detection for a header-backed curve-reader arg', () => {
    const bytes = new Uint8Array(0x18000);
    // Axis at SA 0x150: count-prefixed (u8) strictly increasing run of 12.
    putSA(bytes, 0x150, [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // Curve-reader arg sa 0x300; sa-2 (=0x2fe) holds LE(0x150) — a valid backward axis pointer.
    putSA(bytes, 0x2fe, [0x50, 0x01]);

    const calls: ReaderCall[] = [call(0x1200, 0x300)];
    const readers = new Map<number, 1 | 2>([[0x1200, 1]]);

    const result = detectMs41Curves(bytes, calls, readers, DEFAULT_SCAN_CONFIG);

    expect(CURVE_TIER).toBe(4);
    expect(result).toEqual([
      {
        address: saToFo(0x300),
        rows: 12,
        cols: 1,
        format: { width: 1, signed: false, endianness: 'big' },
        score: 0.9,
        tier: CURVE_TIER,
        kind: '1d',
        yAxis: {
          address: saToFo(0x151),
          count: 12,
          format: { width: 1, signed: false, endianness: 'big' },
        },
      },
    ]);
  });

  it('carries the reader width into the detection format (w=2 → u16le cells)', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x150, [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    putSA(bytes, 0x2fe, [0x50, 0x01]); // sa-2 = LE(0x150)

    const calls: ReaderCall[] = [call(0x1300, 0x300)];
    const readers = new Map<number, 1 | 2>([[0x1300, 2]]);

    expect(detectMs41Curves(bytes, calls, readers, DEFAULT_SCAN_CONFIG)).toEqual([
      {
        address: saToFo(0x300),
        rows: 12,
        cols: 1,
        format: { width: 2, signed: false, endianness: 'little' },
        score: 0.9,
        tier: CURVE_TIER,
        kind: '1d',
        yAxis: {
          address: saToFo(0x151),
          count: 12,
          format: { width: 1, signed: false, endianness: 'big' },
        },
      },
    ]);
  });

  it('emits at the top cal boundary: sa 0x5ffc with a 4-count u8 curve spans exactly to the 0x6000 cal bound', () => {
    // Pins the range guard's PLACEMENT from the inside: sa 0x5ffc <= MS41_CAL_SA_MAX
    // must be accepted, and its byteLen-4 span ends exactly at the 0x6000 cal cap.
    // A tightened or typo'd range guard (e.g. > MS41_CAL_SA_MAX - 4, or a masked sa)
    // turns this red.
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x150, [4, 10, 20, 30, 40]); // axis count 4 == curveAxisMinCount
    putSA(bytes, 0x5ffa, [0x50, 0x01]); // sa-2 = LE(0x150), backward

    const calls: ReaderCall[] = [call(0x1200, 0x5ffc)];
    const readers = new Map<number, 1 | 2>([[0x1200, 1]]);

    expect(detectMs41Curves(bytes, calls, readers, DEFAULT_SCAN_CONFIG)).toEqual([
      {
        address: saToFo(0x5ffc),
        rows: 4,
        cols: 1,
        format: { width: 1, signed: false, endianness: 'big' },
        score: 0.9,
        tier: CURVE_TIER,
        kind: '1d',
        yAxis: {
          address: saToFo(0x151),
          count: 4,
          format: { width: 1, signed: false, endianness: 'big' },
        },
      },
    ]);
  });

  it('emits nothing when the sa-2 pointer is FORWARD (ptr >= sa)', () => {
    const bytes = new Uint8Array(0x18000);
    // Valid axis AHEAD of the arg — would validate if the direction guard weren't applied.
    putSA(bytes, 0x900, [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // Curve-reader arg sa 0x400; sa-2 (=0x3fe) holds LE(0x900), a forward pointer (0x900 >= 0x400).
    putSA(bytes, 0x3fe, [0x00, 0x09]);

    const calls: ReaderCall[] = [call(0x1200, 0x400)];
    const readers = new Map<number, 1 | 2>([[0x1200, 1]]);

    expect(detectMs41Curves(bytes, calls, readers, DEFAULT_SCAN_CONFIG)).toEqual([]);
  });

  it('excludes out-of-cal-range SAs at both bounds while an in-range control emits from the same buffer', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x150, [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // In-range control at sa 0x300: proves the axis/header seeding genuinely
    // emits, so the two exclusions below are not vacuous.
    putSA(bytes, 0x2fe, [0x50, 0x01]);
    // HIGH bound, maximally seeded: sa 0x6000 = MS41_CAL_SA_MAX+1 carries the SAME
    // valid backward header (ptr 0x150 < sa; validateAxisPtr accepts the pointee).
    // The range guard excludes it first. NOTE the exclusion is belt-and-suspenders
    // by construction: even with the range guard deleted, saSpanContiguous(0x6000,
    // byteLen>=1) can never pass (hard cal-bound cap) — hand-traced AND verified
    // by temporarily removing the guard (2026-07-15). This case therefore pins the
    // exclusion CONTRACT (an out-of-range SA never emits, however seeded); the
    // guard's boundary placement is pinned from the inside by the 0x5ffc test.
    putSA(bytes, 0x5ffe, [0x50, 0x01]);
    // LOW bound: sa 3 < MS41_CAL_SA_MIN. Intrinsically shadowed too — a backward
    // ptr < 3 can never reach MS41_CAL_SA_MIN, so validateAxisPtr could never
    // accept one; seeded anyway (ptr 0x150 here also fails the backward check).
    putSA(bytes, 1, [0x50, 0x01]);

    const calls: ReaderCall[] = [call(0x1200, 3), call(0x1200, 0x300), call(0x1200, 0x6000)];
    const readers = new Map<number, 1 | 2>([[0x1200, 1]]);

    const result = detectMs41Curves(bytes, calls, readers, DEFAULT_SCAN_CONFIG);
    expect(result.map((d) => d.address)).toEqual([saToFo(0x300)]);
  });
});

describe('detectMs41CurveFallbacks — tier 5 header fallback', () => {
  // count-3 axis: valid backward header BELOW the tier-0 floor (curveAxisMinCount 4)
  // but at/above the emission floor (curveEmitMinCount 2) → tier-5 N×1 emission.
  it('emits a tier-5 curve for a count-3 header (below the tier-0 floor)', () => {
    const { bytes, calls, readers, sa } = craftHeaderCurve({ count: 3 }); // axis 3 cells strict, header at sa-2
    const t0 = detectMs41Curves(bytes, calls, readers, DEFAULT_SCAN_CONFIG);
    expect(t0).toHaveLength(0); // tier-0 floor rejects count 3
    const fb = detectMs41CurveFallbacks(bytes, calls, readers, DEFAULT_SCAN_CONFIG);
    expect(fb).toHaveLength(1);
    expect(fb[0]!.tier).toBe(CURVE_FALLBACK_TIER);
    expect(fb[0]!.kind).toBe('1d');
    expect(fb[0]!.rows).toBe(3);
    expect(fb[0]!.cols).toBe(1);
    expect(fb[0]!.address).toBe(saToFo(sa));
  });
  it('does NOT re-emit an SA the tier-0 header path already owns', () => {
    const { bytes, calls, readers } = craftHeaderCurve({ count: 12 }); // valid at the tier-0 floor
    expect(detectMs41Curves(bytes, calls, readers, DEFAULT_SCAN_CONFIG)).toHaveLength(1);
    expect(detectMs41CurveFallbacks(bytes, calls, readers, DEFAULT_SCAN_CONFIG)).toHaveLength(0);
  });
  it('emits nothing when the header count is below curveEmitMinCount', () => {
    const { bytes, calls, readers } = craftHeaderCurve({ count: 1 }); // count 1 < 2
    expect(detectMs41CurveFallbacks(bytes, calls, readers, DEFAULT_SCAN_CONFIG)).toHaveLength(0);
  });
});

/**
 * Forward tier-6 adjacency layout: [prefix c][axis c cells of width aw][data
 * at sa]. Cells are 0-indexed strictly-increasing values (0..c-1) — kept low
 * so no shorter sub-run inside the axis's own bytes accidentally reads back
 * as a smaller in-range count (hand-verified for c=4, aw=1|2). sa-2 is left
 * as whatever the crafted axis bytes happen to hold there; for these values
 * that always fails validateAxisPtr (forward pointer, or too small a count),
 * so tier 0/5 never claims sa — only adjacency can fire.
 */
function craftFwdAdjCurve({ c, aw }: { c: number; aw: 1 | 2 }): {
  bytes: Uint8Array;
  calls: ReaderCall[];
  readers: Map<number, 1 | 2>;
  sa: number;
  axisDataSA: number;
} {
  const bytes = new Uint8Array(0x18000);
  const sa = 0x300;
  const p = sa - aw * (c + 1);
  const axisDataSA = p + aw;
  putSA(bytes, p, aw === 1 ? [c] : [c & 0xff, (c >> 8) & 0xff]);
  for (let i = 0; i < c; i++) {
    const v = i;
    const at = axisDataSA + i * aw;
    putSA(bytes, at, aw === 1 ? [v] : [v & 0xff, (v >> 8) & 0xff]);
  }
  const calls: ReaderCall[] = [call(FALLBACK_TARGET, sa)];
  const readers = new Map<number, 1 | 2>([[FALLBACK_TARGET, 1]]);
  return { bytes, calls, readers, sa, axisDataSA };
}

/**
 * Reversed tier-6 adjacency layout: [data c×w at sa][prefix c][axis c×w
 * (aw=1)]. Cells are 0-indexed for the same reason as the forward craft; sa-2
 * is left untouched (0), an invalid backward header.
 */
function craftRevAdjCurve({ c }: { c: number }): {
  bytes: Uint8Array;
  calls: ReaderCall[];
  readers: Map<number, 1 | 2>;
  sa: number;
} {
  const bytes = new Uint8Array(0x18000);
  const sa = 0x300;
  const w = 1;
  const p = sa + c * w;
  const cells = Array.from({ length: c }, (_, i) => i);
  putSA(bytes, p, [c, ...cells]);
  const calls: ReaderCall[] = [call(FALLBACK_TARGET, sa)];
  const readers = new Map<number, 1 | 2>([[FALLBACK_TARGET, w]]);
  return { bytes, calls, readers, sa };
}

/**
 * Nests a def-true forward cNear-axis inside a forward cFar-axis so BOTH
 * self-validate at the same sa: cFar's cells are 0..cFar-1, with the value at
 * index (cFar-cNear-1) equal to cNear reused as cNear's own count prefix, and
 * the following cNear cells doubling as cNear's axis run (hand-verified for
 * cNear=2, cFar=5 — requires cFar <= 2*cNear+1 for the low prefix to stay
 * below cNear throughout).
 */
function craftAmbiguousFwd({ cNear, cFar }: { cNear: number; cFar: number }): {
  bytes: Uint8Array;
  calls: ReaderCall[];
  readers: Map<number, 1 | 2>;
  sa: number;
} {
  const bytes = new Uint8Array(0x18000);
  const sa = 0x300;
  const pFar = sa - (cFar + 1); // aw=1
  const nearIdx = cFar - cNear - 1;
  const farCells: number[] = [];
  for (let i = 0; i < nearIdx; i++) farCells.push(i);
  for (let i = nearIdx; i < cFar; i++) farCells.push(cNear + (i - nearIdx));
  putSA(bytes, pFar, [cFar, ...farCells]);
  const calls: ReaderCall[] = [call(FALLBACK_TARGET, sa)];
  const readers = new Map<number, 1 | 2>([[FALLBACK_TARGET, 1]]);
  return { bytes, calls, readers, sa };
}

/**
 * A curve-reader arg with a wide 0xFF neighborhood: every u8 read is 255 and
 * every u16 LE read is 0 / 0x00FF / 0xFF00 / 0xFFFF — all outside
 * [curveEmitMinCount, maxCount] — so no forward/reversed/width interpretation
 * can self-validate anywhere tier 6 probes.
 */
function craftBareArg(): {
  bytes: Uint8Array;
  calls: ReaderCall[];
  readers: Map<number, 1 | 2>;
} {
  const bytes = new Uint8Array(0x18000);
  const sa = 0x300;
  for (let i = sa - 200; i <= sa + 200; i++) bytes[saToFo(i)] = 0xff;
  const calls: ReaderCall[] = [call(FALLBACK_TARGET, sa)];
  const readers = new Map<number, 1 | 2>([[FALLBACK_TARGET, 1]]);
  return { bytes, calls, readers };
}

/**
 * A valid count-2 backward header (below the tier-0 floor, at/above the
 * emission floor) PLUS a self-consistent reversed adjacency layout at the
 * same sa — proves tier 6 never re-attempts an SA tier 5 already claimed.
 */
function craftHeaderPlusAdj(): {
  bytes: Uint8Array;
  calls: ReaderCall[];
  readers: Map<number, 1 | 2>;
} {
  const bytes = new Uint8Array(0x18000);
  const sa = 0x300;
  const p = 0x150;
  putSA(bytes, p, [2, 0, 1]); // count=2, cells [0,1] strictly increasing
  putSA(bytes, sa - 2, [p & 0xff, (p >> 8) & 0xff]); // sa-2 = LE(p), backward, valid header
  const c = 3;
  const pRev = sa + c;
  const cells = Array.from({ length: c }, (_, i) => i);
  putSA(bytes, pRev, [c, ...cells]); // self-consistent reversed layout, must be unreachable
  const calls: ReaderCall[] = [call(FALLBACK_TARGET, sa)];
  const readers = new Map<number, 1 | 2>([[FALLBACK_TARGET, 1]]);
  return { bytes, calls, readers };
}

describe('detectMs41CurveFallbacks — tier 6 adjacency', () => {
  it('forward u8-prefix: [prefix c][axis c×u8][data] with axis ending at sa', () => {
    // prefix at p = sa - 1*(c+1), c=4: u8[p]=4, 4 strictly-monotone u8 cells, data at sa
    const { bytes, calls, readers, axisDataSA } = craftFwdAdjCurve({ c: 4, aw: 1 });
    const fb = detectMs41CurveFallbacks(bytes, calls, readers, DEFAULT_SCAN_CONFIG);
    expect(fb).toHaveLength(1);
    expect(fb[0]!.tier).toBe(CURVE_ADJ_TIER);
    expect(fb[0]!.rows).toBe(4);
    expect(fb[0]!.yAxis?.address).toBe(saToFo(axisDataSA));
  });
  it('forward u16-prefix (the 0x368a form): prefix at sa - 2*(c+1)', () => {
    const { bytes, calls, readers } = craftFwdAdjCurve({ c: 4, aw: 2 }); // u16 count prefix, 4 u16 cells
    const fb = detectMs41CurveFallbacks(bytes, calls, readers, DEFAULT_SCAN_CONFIG);
    expect(fb).toHaveLength(1);
    expect(fb[0]!.rows).toBe(4);
    expect(fb[0]!.yAxis?.format.width).toBe(2);
  });
  it('reversed: [data c×w][prefix][axis]', () => {
    const { bytes, calls, readers, sa } = craftRevAdjCurve({ c: 3 }); // prefix at sa + 3*w
    const fb = detectMs41CurveFallbacks(bytes, calls, readers, DEFAULT_SCAN_CONFIG);
    expect(fb).toHaveLength(1);
    expect(fb[0]!.rows).toBe(3);
    expect(fb[0]!.address).toBe(saToFo(sa));
  });
  it('ambiguity resolves to the SMALLEST c (nearest structure)', () => {
    // craft BOTH a fwd c=2 and a fwd c=5 self-consistent interpretation
    const { bytes, calls, readers } = craftAmbiguousFwd({ cNear: 2, cFar: 5 });
    const fb = detectMs41CurveFallbacks(bytes, calls, readers, DEFAULT_SCAN_CONFIG);
    expect(fb).toHaveLength(1);
    expect(fb[0]!.rows).toBe(2);
  });
  it('emits nothing when no self-consistent interpretation exists', () => {
    const { bytes, calls, readers } = craftBareArg(); // arg with garbage around it
    expect(detectMs41CurveFallbacks(bytes, calls, readers, DEFAULT_SCAN_CONFIG)).toHaveLength(0);
  });
  it('an SA claimed by tier 5 is not re-attempted by tier 6', () => {
    // valid count-2 header AND a valid rev-adjacency layout → exactly one emission, tier 5
    const { bytes, calls, readers } = craftHeaderPlusAdj();
    const fb = detectMs41CurveFallbacks(bytes, calls, readers, DEFAULT_SCAN_CONFIG);
    expect(fb).toHaveLength(1);
    expect(fb[0]!.tier).toBe(CURVE_FALLBACK_TIER);
  });
});
