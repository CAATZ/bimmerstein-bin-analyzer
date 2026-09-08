import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import { scan } from '../src/index.js';
import { saToFo } from '../src/family/ms41/frame.js';
import {
  detectMs41Tables,
  buildMs41Starts,
  ms41Analyzer,
  scanRelaxedHeaderTables,
  type FamilyStart,
} from '../src/family/ms41/analyzer.js';
import { FAMILY_ANALYZERS, runFamilyAnalyzers } from '../src/family/index.js';
import type { ReaderCall } from '../src/family/ms41/c166.js';
import type { PrefixedAxis } from '../src/pool.js';

function putSA(bytes: Uint8Array, sa: number, vals: number[]): void {
  for (let i = 0; i < vals.length; i++) bytes[saToFo(sa + i)] = vals[i]!;
}
/** x axis count 6 @SA 0x100, y axis count 4 @SA 0x200, smooth 4×6 u8 table data at `sa`. */
function plantTable(bytes: Uint8Array, sa: number, withHeader: boolean): void {
  putSA(bytes, 0x100, [6, 10, 20, 30, 40, 50, 60]);
  putSA(bytes, 0x200, [4, 50, 60, 70, 80]);
  if (withHeader) putSA(bytes, sa - 4, [0x00, 0x01, 0x00, 0x02]); // [xPtr 0x100][yPtr 0x200]
  const data: number[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) data.push(100 + r * 2 + c);
  putSA(bytes, sa, data);
}
const start = (sa: number, w: 1 | 2 = 1): FamilyStart => ({ sa, fo: saToFo(sa), w });
const u8 = { width: 1, signed: false, endianness: 'big' } as const;

it('does not turn a code-read curve header into a grid covering adjacent curves', () => {
  const bytes = new Uint8Array(0x18000);
  plantTable(bytes, 0x300, true);
  plantTable(bytes, 0x400, true);
  const curve = { address: saToFo(0x300), rows: 4, cols: 1, format: u8,
    tier: 4, kind: '1d' as const, score: 0.9 };
  const found = scanRelaxedHeaderTables(bytes, [], DEFAULT_SCAN_CONFIG, [curve]);
  expect(found.some(m => m.address === curve.address)).toBe(false);
  expect(found.some(m => m.address === saToFo(0x400))).toBe(true);
  expect(scanRelaxedHeaderTables(bytes, [], DEFAULT_SCAN_CONFIG, [{ ...curve, tier: 6 }])
    .some(m => m.address === curve.address)).toBe(true);
});

it('keeps proven curves and parameters out of inferred grids while retaining valid headers', () => {
  const bytes = new Uint8Array(0x18000);
  plantTable(bytes, 0x300, false);
  const pool = [
    { address: saToFo(0x2e0), end: saToFo(0x2e4), count: 4, format: u8 },
    { address: saToFo(0x2fa), end: saToFo(0x300), count: 6, format: u8 },
  ];
  const curve = { address: saToFo(0x310), rows: 4, cols: 1, format: u8,
    tier: 4, kind: '1d' as const, score: 0.9 };
  expect(detectMs41Tables(bytes, [start(0x300)], pool, DEFAULT_SCAN_CONFIG).length).toBeGreaterThan(0);
  expect(detectMs41Tables(bytes, [start(0x300)], pool, DEFAULT_SCAN_CONFIG, [curve])).toEqual([]);
  expect(detectMs41Tables(bytes, [start(0x300)], pool, DEFAULT_SCAN_CONFIG, [{ ...curve, tier: 6 }]).length).toBeGreaterThan(0);
  const param = { ...curve, rows: 1, kind: 'param' as const, tier: 9 };
  expect(detectMs41Tables(bytes, [start(0x300)], pool, DEFAULT_SCAN_CONFIG, [param])).toEqual([]);
  plantTable(bytes, 0x300, true);
  expect(detectMs41Tables(bytes, [start(0x300)], pool, DEFAULT_SCAN_CONFIG, [curve])[0]?.tier).toBe(0);
});

it('uses the established grid-reader width when a flat header scan is ambiguous', () => {
  const bytes = new Uint8Array(0x18000);
  plantTable(bytes, 0x300, true);
  putSA(bytes, 0x300, Array.from({ length: 48 }, () => 255));
  const found = scanRelaxedHeaderTables(bytes, [start(0x300, 1)], DEFAULT_SCAN_CONFIG);
  expect(found.find(m => m.address === saToFo(0x300))).toMatchObject({ rows: 4, cols: 6, format: { width: 1 } });
  const words = scanRelaxedHeaderTables(bytes, [start(0x300, 2)], DEFAULT_SCAN_CONFIG);
  expect(words.find(m => m.address === saToFo(0x300))?.format.width).toBe(2);
});

describe('detectMs41Tables — header path', () => {
  it('emits exact dims and axis addresses from a valid header', () => {
    const bytes = new Uint8Array(0x18000);
    plantTable(bytes, 0x300, true);
    const found = detectMs41Tables(bytes, [start(0x300)], [], DEFAULT_SCAN_CONFIG);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      address: saToFo(0x300),
      rows: 4,
      cols: 6,
      tier: 0,
      xAxis: { address: saToFo(0x101), count: 6 },
      yAxis: { address: saToFo(0x201), count: 4 },
    });
    expect(found[0]!.format).toEqual(u8);
    expect(found[0]!.score).toBeCloseTo(0.75, 5);
  });

  it('emits dead (flat) tables too — smoothness is NOT gated on the header path', () => {
    const bytes = new Uint8Array(0x18000);
    plantTable(bytes, 0x300, true);
    putSA(bytes, 0x300, Array.from({ length: 24 }, () => 0x42)); // overwrite data: flat
    const found = detectMs41Tables(bytes, [start(0x300)], [], DEFAULT_SCAN_CONFIG);
    expect(found).toHaveLength(1);
    expect(found[0]!.tier).toBe(0);
    expect(found[0]!.score).toBeCloseTo(0.1, 5);
  });

  it('rejects a header whose table would overrun the gap to the next start', () => {
    const bytes = new Uint8Array(0x18000);
    plantTable(bytes, 0x300, true);
    // second start 8 bytes later: gap 8 < byteLen 24 → header path must refuse
    const found = detectMs41Tables(bytes, [start(0x300), start(0x308)], [], DEFAULT_SCAN_CONFIG);
    expect(found).toEqual([]);
  });

  it('ignores out-of-range start SAs (defensive guard on the exported API)', () => {
    const bytes = new Uint8Array(0x18000);
    plantTable(bytes, 0x300, true);
    expect(detectMs41Tables(bytes, [start(2)], [], DEFAULT_SCAN_CONFIG)).toEqual([]);
  });

  it('accepts a 3-count-axis header (headerAxisMinCount 2 — the Class A pattern)', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x100, [3, 10, 20, 30]); // x axis, count 3 < axis.minCount 4
    putSA(bytes, 0x200, [8, 5, 15, 25, 35, 45, 55, 65, 75]); // y axis, count 8
    putSA(bytes, 0x2fc, [0x00, 0x01, 0x00, 0x02]); // [xPtr 0x100][yPtr 0x200]
    const data: number[] = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 3; c++) data.push(100 + r * 2 + c);
    putSA(bytes, 0x300, data);
    const found = detectMs41Tables(bytes, [start(0x300)], [], DEFAULT_SCAN_CONFIG);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      address: saToFo(0x300),
      rows: 8,
      cols: 3,
      tier: 0,
      xAxis: { address: saToFo(0x101), count: 3 },
      yAxis: { address: saToFo(0x201), count: 8 },
    });
  });

  it('rejects a same-pointer phantom header (xPtr === yPtr — the 0x39BE pattern)', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x100, [4, 10, 20, 30, 40]); // a perfectly valid axis…
    putSA(bytes, 0x2fc, [0x00, 0x01, 0x00, 0x01]); // …but BOTH pointers address it
    putSA(bytes, 0x300, Array.from({ length: 16 }, (_, i) => 100 + i));
    expect(detectMs41Tables(bytes, [start(0x300)], [], DEFAULT_SCAN_CONFIG)).toEqual([]);
  });

  it('rejects a forward-pointer phantom header (real headers always point backward)', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x400, [6, 10, 20, 30, 40, 50, 60]); // valid axes AFTER the start
    putSA(bytes, 0x420, [4, 50, 60, 70, 80]);
    putSA(bytes, 0x2fc, [0x00, 0x04, 0x20, 0x04]); // [xPtr 0x400][yPtr 0x420] — forward
    putSA(bytes, 0x300, Array.from({ length: 24 }, (_, i) => 100 + i));
    expect(detectMs41Tables(bytes, [start(0x300)], [], DEFAULT_SCAN_CONFIG)).toEqual([]);
  });
});

describe('detectMs41Tables — pool-pair fallback', () => {
  const pool = (address: number, count: number): PrefixedAxis => ({
    address,
    count,
    format: u8,
    end: address + count,
    maximal: true,
  });

  it('binds a headerless start to a preceding pool pair', () => {
    const bytes = new Uint8Array(0x18000);
    plantTable(bytes, 0x300, false); // no header
    const fo = saToFo(0x300);
    const poolMax = [pool(fo - 0x20, 6), pool(fo - 0x10, 4)];
    const found = detectMs41Tables(bytes, [start(0x300)], poolMax, DEFAULT_SCAN_CONFIG);
    expect(found.some((d) => d.tier === 2 && d.rows === 4 && d.cols === 6 && d.address === fo)).toBe(true);
    const hit = found.find((d) => d.rows === 4 && d.cols === 6)!;
    expect(hit.xAxis).toMatchObject({ address: fo - 0x20, count: 6 });
    expect(hit.yAxis).toMatchObject({ address: fo - 0x10, count: 4 });
  });

  it('uses a resolved caller only to choose between existing fallback axis pairs', () => {
    const bytes = new Uint8Array(0x18000);
    plantTable(bytes, 0x300, false);
    const fo = saToFo(0x300), axes = [pool(fo - 0x30, 6), pool(fo - 0x20, 4), pool(fo - 6, 6)];
    const before = detectMs41Tables(bytes, [start(0x300)], axes, DEFAULT_SCAN_CONFIG);
    const preferred = before.find(m => m.rows === 4 && m.cols === 6 && m.xAxis?.address === fo - 0x30)!;
    expect(preferred).toBeDefined();
    const hints = new Map([[fo, preferred]]);
    const after = detectMs41Tables(bytes, [start(0x300)], axes, DEFAULT_SCAN_CONFIG, [], hints);
    expect(after).toEqual([preferred]);
    expect(preferred.tier).toBe(2);
    // A missing pool interpretation cannot create or remove a candidate.
    hints.set(fo, { ...preferred, xAxis: { ...preferred.xAxis!, address: fo - 0x40 } });
    expect(detectMs41Tables(bytes, [start(0x300)], axes, DEFAULT_SCAN_CONFIG, [], hints)).toEqual(before);
    plantTable(bytes, 0x300, true);
    expect(detectMs41Tables(bytes, [start(0x300)], axes, DEFAULT_SCAN_CONFIG, [], hints))
      .toEqual(detectMs41Tables(bytes, [start(0x300)], axes, DEFAULT_SCAN_CONFIG));
  });

  it('enforces extent-hard: byteLen > gap to the next start emits nothing', () => {
    const bytes = new Uint8Array(0x18000);
    plantTable(bytes, 0x300, false);
    const fo = saToFo(0x300);
    const poolMax = [pool(fo - 0x20, 6), pool(fo - 0x10, 4)];
    const found = detectMs41Tables(bytes, [start(0x300), start(0x310)], poolMax, DEFAULT_SCAN_CONFIG);
    expect(found.filter((d) => d.address === fo && d.rows * d.cols === 24)).toEqual([]);
  });

  it('requires the pair members within pool.pairSpan of each other', () => {
    const bytes = new Uint8Array(0x18000);
    plantTable(bytes, 0x300, false);
    const fo = saToFo(0x300);
    const poolMax = [pool(fo - 0x800, 6), pool(fo - 0x10, 4)]; // span (fo-0x10)-(fo-0x800+6) = 0x7ea > 64
    const found = detectMs41Tables(bytes, [start(0x300)], poolMax, DEFAULT_SCAN_CONFIG);
    expect(found).toEqual([]);
  });

  it('gates fallback (only) on table smoothness', () => {
    const bytes = new Uint8Array(0x18000);
    plantTable(bytes, 0x300, false);
    // overwrite data with a harsh checkerboard → frameScore < minTableScore 0.5
    putSA(bytes, 0x300, Array.from({ length: 24 }, (_, i) => (i % 2 ? 250 : 0)));
    const fo = saToFo(0x300);
    const poolMax = [pool(fo - 0x20, 6), pool(fo - 0x10, 4)];
    expect(detectMs41Tables(bytes, [start(0x300)], poolMax, DEFAULT_SCAN_CONFIG)).toEqual([]);
  });

  it('waives the smoothness floor for an adjacency-TIGHT pair (dead table, axis run ends at the start)', () => {
    const bytes = new Uint8Array(0x18000);
    plantTable(bytes, 0x300, false);
    putSA(bytes, 0x300, Array.from({ length: 24 }, () => 0x80)); // dead: all 0x80 (the 0x35B8 pattern)
    const fo = saToFo(0x300);
    const poolMax = [pool(fo - 0x20, 6), pool(fo - 4, 4)]; // y ends EXACTLY at the start
    const found = detectMs41Tables(bytes, [start(0x300)], poolMax, DEFAULT_SCAN_CONFIG);
    expect(found.some((d) => d.rows === 4 && d.cols === 6 && d.tier === 1 && Math.abs(d.score - 0.1) < 1e-9)).toBe(true);
  });
});

describe('buildMs41Starts', () => {
  const rc = (targetCpu: number, sa: number): ReaderCall => ({ siteFile: 0, targetCpu, sa, dist: 0 });

  it('collects distinct reader args with the reader width, sorted by SA', () => {
    const calls = [rc(0x1000, 0x400), rc(0x1000, 0x300), rc(0x2000, 0x500), rc(0x1000, 0x300)];
    const starts = buildMs41Starts(calls, [{ target: 0x1000, width: 1 }]);
    expect(starts).toEqual([
      { sa: 0x300, fo: saToFo(0x300), w: 1 },
      { sa: 0x400, fo: saToFo(0x400), w: 1 },
    ]);
  });

  it('a later call wins the width when the same SA is reached through a different-width reader', () => {
    const calls = [rc(0x1000, 0x300), rc(0x1100, 0x300)];
    const starts = buildMs41Starts(calls, [
      { target: 0x1000, width: 1 },
      { target: 0x1100, width: 2 },
    ]);
    expect(starts).toEqual([{ sa: 0x300, fo: saToFo(0x300), w: 2 }]);
  });
});

/**
 * A gate-clearing mini-image: 200 MOV+CALLS sites — with a second reader:
 * 190 to the byte reader at cpu 0x1000 (6 distinct header-backed SAs), 5 to
 * a second byte reader at cpu 0x1200 (5 of the same SAs), 5 to a headerless
 * target at cpu 0x2000; shared axis pair, six 4×6 u8 tables at 0x40-spaced
 * SAs. With secondReader=false, all 195 go to 0x1000 (only ONE reader
 * self-locates → gate must stay inert at minReaders 2).
 */
function buildActiveImage(secondReader: boolean): { bytes: Uint8Array; sas: number[] } {
  const bytes = new Uint8Array(0x18000);
  putSA(bytes, 0x100, [6, 10, 20, 30, 40, 50, 60]);
  putSA(bytes, 0x200, [4, 50, 60, 70, 80]);
  const sas = [0x300, 0x340, 0x380, 0x3c0, 0x400, 0x440];
  for (const sa of sas) {
    putSA(bytes, sa - 4, [0x00, 0x01, 0x00, 0x02]);
    const data: number[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) data.push(100 + r * 2 + c);
    putSA(bytes, sa, data);
  }
  bytes.set([0xa9, 0x24], 0x5000); // byte-reader body at CPU 0x1000
  bytes.set([0xa9, 0x24], 0x5200); // byte-reader body at CPU 0x1200
  let o = 0x40;
  const aSites = secondReader ? 190 : 195;
  for (let i = 0; i < aSites; i++) {
    const sa = sas[i % 6]!;
    bytes.set([0xe6, 0xfc, sa & 0xff, sa >> 8, 0xda, 0x00, 0x00, 0x10], o); // CALLS 0x001000
    o += 8;
  }
  if (secondReader) {
    for (const sa of sas.slice(0, 5)) {
      bytes.set([0xe6, 0xfc, sa & 0xff, sa >> 8, 0xda, 0x00, 0x00, 0x12], o); // CALLS 0x001200
      o += 8;
    }
  }
  for (const sa of [0x500, 0x510, 0x520, 0x530, 0x540]) {
    bytes.set([0xe6, 0xfc, sa & 0xff, sa >> 8, 0xda, 0x00, 0x00, 0x20], o); // CALLS 0x002000
    o += 8;
  }
  return { bytes, sas };
}

/**
 * Extends a gate-clearing image (buildActiveImage output) with a
 * self-locatable CURVE reader at cpu 0x1400: 6 distinct cal-SA args (one
 * CALLS site each, so curveArgs — the wiring's CALL-SITE count, not
 * distinct-arg count — is also 6, below the default curveActivateMin 20),
 * each backed by a valid backward 2-byte axis pointer to a count-4 axis
 * (curveAxisMinCount). sa-4 is left zeroed so the target fails the grid
 * reader's 4-byte header test (mirrors family-readers.test.ts's grid-
 * exclusion fixture) and is picked up ONLY by selfLocateCurveReaders.
 */
function addCurveReader(bytes: Uint8Array): number[] {
  putSA(bytes, 0x150, [4, 1, 2, 3, 4]); // curve axis: count 4, strictly increasing
  const curveSas = [0x700, 0x740, 0x780, 0x7c0, 0x800, 0x840];
  for (const sa of curveSas) putSA(bytes, sa - 2, [0x50, 0x01]); // LE(0x150), backward
  bytes.set([0xa9, 0x24], 0x5400); // byte-reader body at cpu 0x1400
  let o = 0x680; // free space after buildActiveImage's 200 MOV+CALLS sites
  for (const sa of curveSas) {
    bytes.set([0xe6, 0xfc, sa & 0xff, sa >> 8, 0xda, 0x00, 0x00, 0x14], o); // MOV r12,#sa; CALLS 0x001400
    o += 8;
  }
  return curveSas;
}

/**
 * Extends addCurveReader's fixture (P1.1 Task 3) with ONE additional cal-SA
 * (0x880) whose backward 2-byte header addresses a count-3 strict axis:
 * count 3 < curveAxisMinCount (4), so the tier-4 header path
 * (detectMs41Curves) refuses it, but count 3 >= curveEmitMinCount (2), so
 * the fallback tier-5 path (detectMs41CurveFallbacks) claims it. Also adds
 * 14 repeat CALLS sites (reusing addCurveReader's 6 SAs) so the TOTAL
 * curve-reader call-site count is 6 + 1 + 14 = 21 — at/above the DEFAULT
 * curveActivateMin (20), so the fallback tier activates under the real
 * production gate with no config override.
 */
function addCurveReaderAboveFloor(bytes: Uint8Array): { curveSas: number[]; count3Sa: number } {
  const curveSas = addCurveReader(bytes);
  putSA(bytes, 0x160, [3, 1, 2, 3]); // count-3 strict axis
  const count3Sa = 0x880;
  putSA(bytes, count3Sa - 2, [0x60, 0x01]); // LE(0x160), backward header
  let o = 0x6b0; // free space after addCurveReader's 6 sites
  bytes.set(
    [0xe6, 0xfc, count3Sa & 0xff, count3Sa >> 8, 0xda, 0x00, 0x00, 0x14],
    o
  ); // MOV r12,#count3Sa; CALLS 0x001400
  o += 8;
  for (let i = 0; i < 14; i++) {
    const sa = curveSas[i % curveSas.length]!;
    bytes.set([0xe6, 0xfc, sa & 0xff, sa >> 8, 0xda, 0x00, 0x00, 0x14], o); // padding CALL to cross curveActivateMin
    o += 8;
  }
  return { curveSas, count3Sa };
}

describe('ms41Analyzer (activation gate + end-to-end)', () => {
  it('uses the staged grid contract in place of a stale same-start header', () => {
    const { bytes } = buildActiveImage(true);
    bytes.set([0xc2, 0xfa, 0x82, 0xe9, 0xc2, 0xf1, 0x80, 0xe9, 0x1b, 0xa1, 0xc2, 0xf1, 0x81, 0xe9, 0x02, 0xf1, 0x0e, 0xfe, 0, 0x1c, 0xa9, 0x81, 0xdb, 0], 0x5000);
    bytes.set([0xa8, 0x3c, 0x99, 0x43, 0xf7, 0xf4, 0x80, 0xe9, 0xdb, 0], 0x5400);
    bytes.set([0xa8, 0x3c, 0x99, 0x43, 0xf7, 0xf4, 0x81, 0xe9, 0xf7, 0xf4, 0x82, 0xe9, 0xdb, 0], 0x5440);
    putSA(bytes, 0x150, [3, 10, 20, 30]);
    putSA(bytes, 0x600, [0, 2, 0x50, 1]);
    plantTable(bytes, 0x480, true);
    bytes.set([0xdb, 0, 0xe6, 0xfc, 0, 6, 0xda, 0, 0, 0x14, 0xe6, 0xfc, 2, 6, 0xda, 0, 0x40, 0x14, 0xe6, 0xfc, 0x80, 4, 0xda, 0, 0, 0x10, 0xdb, 0], 0x680);
    const found = ms41Analyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG).filter(m => m.address === saToFo(0x480));
    expect(found).toMatchObject([{ rows: 4, cols: 3, xAxis: { address: saToFo(0x151) }, yAxis: { address: saToFo(0x201) } }]);
  });

  it('is inert below the minimum bin length', () => {
    expect(ms41Analyzer.analyze(new Uint8Array(0x1000), [], DEFAULT_SCAN_CONFIG)).toEqual([]);
  });

  it('admits cached header parameters through the existing family and reader gates', () => {
    const { bytes } = buildActiveImage(true);
    putSA(bytes, 0x5300, [2, 0]);
    putSA(bytes, 4, [38]);
    bytes.set([0xe6, 0xf4, 0, 0x53, 0xf6, 0xf4, 0x20, 0xe9, 0xdb, 0], 0x2000);
    bytes.set([0xf2, 0xf4, 0x20, 0xe9, 0xa8, 0x54, 0xf6, 0xf5, 0x40, 0xe9, 0xdb, 0], 0x2100);
    bytes.set([0xf2, 0xf4, 0x40, 0xe9, 0xf4, 0xa4, 2, 0, 0xf7, 0xfa, 0x60, 0xe9, 0xdb, 0], 0x2200);
    bytes.set([0xc2, 0xf5, 0x60, 0xe9, 0x68, 0x51, 0xdb, 0], 0x2300);
    expect(ms41Analyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG).some(p => p.address === saToFo(4))).toBe(false);
    // The active fixture has two readers; lower only this local admission control.
    const config = {...DEFAULT_SCAN_CONFIG, family: {...DEFAULT_SCAN_CONFIG.family,
      ms41: {...DEFAULT_SCAN_CONFIG.family.ms41, paramMinReaders: 2}}};
    expect(ms41Analyzer.analyze(bytes, [], config)).toContainEqual({
      address: saToFo(4), rows: 1, cols: 1, kind: 'param', tier: 9,
      format: {width: 1, signed: false, endianness: 'big'}, score: config.family.ms41.paramConfidence,
    });
  });

  it('is inert below the MOV-immediate activation floor', () => {
    const bytes = new Uint8Array(0x18000);
    bytes.set([0xe6, 0xfc, 0x00, 0x03, 0xda, 0x00, 0x00, 0x10], 0x40); // 1 site << 200
    expect(ms41Analyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG)).toEqual([]);
  });

  it('is inert when only ONE reader self-locates (minReaders 2)', () => {
    const { bytes } = buildActiveImage(false);
    expect(ms41Analyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG)).toEqual([]);
  });

  it('activates on a gate-clearing image and detects every header-backed table', () => {
    const { bytes, sas } = buildActiveImage(true);
    const found = ms41Analyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG);
    expect(found.filter((d) => d.tier === 0)).toHaveLength(6);
    expect(found.some((d) => d.tier === 3)).toBe(true); // the scan tier sees the same headers
    for (const sa of sas) {
      expect(found.some((d) => d.address === saToFo(sa) && d.rows === 4 && d.cols === 6 && d.tier === 0)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const { bytes } = buildActiveImage(true);
    expect(ms41Analyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG)).toEqual(
      ms41Analyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG)
    );
  });

  it('binds a headerless start to a PLATEAU pair through the family fallback pool', () => {
    const { bytes } = buildActiveImage(true);
    // plateau x axis (count 6 = 5 strict + 1 tail) and strict y axis, ending
    // just before a headerless 7th table at SA 0x480
    putSA(bytes, 0x460, [6, 10, 20, 30, 40, 50, 50]);
    putSA(bytes, 0x468, [4, 50, 60, 70, 80]);
    const data: number[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) data.push(100 + r * 2 + c);
    putSA(bytes, 0x480, data);
    let o = 0x680; // free space after buildActiveImage's 200 sites
    for (let i = 0; i < 3; i++) {
      bytes.set([0xe6, 0xfc, 0x80, 0x04, 0xda, 0x00, 0x00, 0x10], o); // MOV r12,#0x480; CALLS 0x001000
      o += 8;
    }
    const found = ms41Analyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG);
    expect(
      found.some(
        (d) =>
          d.address === saToFo(0x480) &&
          d.rows === 4 &&
          d.cols === 6 &&
          d.tier === 2 &&
          d.xAxis?.address === saToFo(0x461) &&
          d.yAxis?.address === saToFo(0x469)
      )
    ).toBe(true);
  });

  it('gates curve emission on curveActivateMin, counted over curve-reader CALL SITES (Task 4)', () => {
    const { bytes } = buildActiveImage(true);
    const curveSas = addCurveReader(bytes);
    expect(curveSas).toHaveLength(6); // < default curveActivateMin (20)

    // Default config: curveArgs (6) < curveActivateMin (20) -> the curve tier stays inert.
    const belowFloor = ms41Analyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG);
    expect(belowFloor.some((d) => d.kind === '1d')).toBe(false);

    // Lowering the floor to exactly the curveArgs count flips the SAME buffer's gate on —
    // proving activation reads config.family.ms41.curveActivateMin against the counted
    // curve-reader-arg calls, not that the tier is unconditionally empty.
    const loweredConfig = {
      ...DEFAULT_SCAN_CONFIG,
      family: {
        ...DEFAULT_SCAN_CONFIG.family,
        ms41: { ...DEFAULT_SCAN_CONFIG.family.ms41, curveActivateMin: 6 },
      },
    };
    const aboveFloor = ms41Analyzer.analyze(bytes, [], loweredConfig);
    const curves = aboveFloor.filter((d) => d.kind === '1d');
    expect(curves).toHaveLength(6);
    expect(curves.every((d) => d.tier === 4 && d.rows === 4 && d.cols === 1)).toBe(true);
    for (const sa of curveSas) {
      expect(curves.some((d) => d.address === saToFo(sa))).toBe(true);
    }
    expect(curves.some((d) => d.tier === 5 || d.tier === 6)).toBe(false);
    expect(belowFloor.some((d) => d.tier === 5 || d.tier === 6)).toBe(false);
  });

  it('emits a fallback TIER 5 curve from a count-3 header once curveArgs crosses the default activation floor (P1.1 Task 3)', () => {
    const { bytes } = buildActiveImage(true);
    const { count3Sa } = addCurveReaderAboveFloor(bytes);

    // curveArgs (21) >= the DEFAULT curveActivateMin (20) — no config override.
    const found = ms41Analyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG);
    const fallback = found.find((d) => d.kind === '1d' && d.address === saToFo(count3Sa));
    expect(fallback).toMatchObject({ tier: 5, rows: 3, cols: 1 });

    // Inertness control: reusing the sub-activation idiom, but RAISED above
    // the actual curveArgs count (21) — proves the fallback tiers (5/6) share
    // the SAME single gate as tier 4, not a separate always-on switch.
    const belowFloorConfig = {
      ...DEFAULT_SCAN_CONFIG,
      family: {
        ...DEFAULT_SCAN_CONFIG.family,
        ms41: { ...DEFAULT_SCAN_CONFIG.family.ms41, curveActivateMin: 22 },
      },
    };
    const belowFloor = ms41Analyzer.analyze(bytes, [], belowFloorConfig);
    expect(belowFloor.some((d) => d.kind === '1d')).toBe(false);
    expect(belowFloor.some((d) => d.tier === 5 || d.tier === 6)).toBe(false);
  });
});

describe('curve tier wiring — inertness on the real (non-code-xref) pipeline (Task 4)', () => {
  it('scan() emits ZERO 1d maps on the committed synthetic fixture synth-1.bin', () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../fixtures/synthetic/synth-1.bin', import.meta.url))
    );
    const result = scan(bytes, DEFAULT_SCAN_CONFIG);
    const oneD = result.potentialMaps.filter((m) => (m.rows === 1) !== (m.cols === 1));
    expect(oneD).toEqual([]);
  });
});

describe('family registry', () => {
  it('contains the ms41 analyzer and dispatches through runFamilyAnalyzers', () => {
    expect(FAMILY_ANALYZERS.map((a) => a.id)).toEqual(['ms41']);
    expect(runFamilyAnalyzers(new Uint8Array(0x1000), [], DEFAULT_SCAN_CONFIG)).toEqual([]);
  });
});

describe('scanRelaxedHeaderTables', () => {
  it('recovers a dead-axis header table (the MAF 0x2AD6 pattern) with exact dims', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x100, [16, ...Array.from({ length: 16 }, () => 0)]); // dead x axis, count 16
    putSA(bytes, 0x120, [16, ...Array.from({ length: 16 }, () => 0)]); // dead y axis, count 16
    putSA(bytes, 0x1fc, [0x00, 0x01, 0x20, 0x01]); // [xPtr 0x100][yPtr 0x120]
    const data: number[] = [];
    for (let i = 0; i < 256; i++) data.push((1000 + i * 3) & 0xff, ((1000 + i * 3) >> 8) & 0xff); // smooth u16 LE
    putSA(bytes, 0x200, data);
    const found = scanRelaxedHeaderTables(bytes, [], DEFAULT_SCAN_CONFIG);
    const hit = found.find((d) => d.address === saToFo(0x200));
    expect(hit).toMatchObject({
      rows: 16,
      cols: 16,
      tier: 3,
      xAxis: { address: saToFo(0x101), count: 16 },
      yAxis: { address: saToFo(0x121), count: 16 },
    });
    expect(hit!.format.width).toBe(2);
  });

  it('prefers the width whose byteLen exactly matches the gap to the next r12 start', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x100, [4, 10, 20, 30, 40]);
    putSA(bytes, 0x120, [4, 50, 60, 70, 80]);
    putSA(bytes, 0x2fc, [0x00, 0x01, 0x20, 0x01]);
    putSA(bytes, 0x300, Array.from({ length: 32 }, (_, i) => 100 + i));
    const w2 = scanRelaxedHeaderTables(bytes, [start(0x320)], DEFAULT_SCAN_CONFIG); // gap 32 == 4×4×2
    expect(w2.find((d) => d.address === saToFo(0x300))!.format.width).toBe(2);
    const w1 = scanRelaxedHeaderTables(bytes, [start(0x310)], DEFAULT_SCAN_CONFIG); // gap 16 == 4×4×1; w2 overruns
    expect(w1.find((d) => d.address === saToFo(0x300))!.format.width).toBe(1);
  });

  it('falls back to the higher frameScore width when neither gap is exact', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x100, [4, 10, 20, 30, 40]);
    putSA(bytes, 0x120, [4, 50, 60, 70, 80]);
    putSA(bytes, 0x2fc, [0x00, 0x01, 0x20, 0x01]);
    putSA(bytes, 0x300, Array.from({ length: 16 }, (_, i) => 100 + i)); // smooth as u8…
    putSA(bytes, 0x310, Array.from({ length: 16 }, (_, i) => (i % 4 < 2 ? 0xff : 0))); // …w2's extra cells alternate 0xFFFF/0x0000
    const found = scanRelaxedHeaderTables(bytes, [], DEFAULT_SCAN_CONFIG);
    expect(found.find((d) => d.address === saToFo(0x300))!.format.width).toBe(1);
  });

  it('skips same/zero/0xFFFF pointers', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x100, [4, 10, 20, 30, 40]);
    putSA(bytes, 0x2fc, [0x00, 0x01, 0x00, 0x01]); // xp === yp
    putSA(bytes, 0x300, Array.from({ length: 16 }, (_, i) => 100 + i));
    expect(scanRelaxedHeaderTables(bytes, [], DEFAULT_SCAN_CONFIG).filter((d) => d.address === saToFo(0x300))).toEqual([]);
  });

  it('rejects forward pointers in the sweep', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x400, [4, 10, 20, 30, 40]);
    putSA(bytes, 0x420, [4, 50, 60, 70, 80]);
    putSA(bytes, 0x2fc, [0x00, 0x04, 0x20, 0x04]); // forward from sa 0x300
    putSA(bytes, 0x300, Array.from({ length: 16 }, (_, i) => 100 + i));
    expect(scanRelaxedHeaderTables(bytes, [], DEFAULT_SCAN_CONFIG).filter((d) => d.address === saToFo(0x300))).toEqual([]);
  });
});
