import { describe, expect, it } from 'vitest';
import { rankAndEmit, startEdgeOk, endEdgeOk } from '../src/score.js';
import { classifyRegions } from '../src/regions.js';
import { scanAxes } from '../src/axes.js';
import { scanTables } from '../src/tables.js';
import { associate } from '../src/associate.js';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import type { AssociatedTable } from '../src/associate.js';
import type { AxisCandidate } from '../src/axes.js';
import type { SwitchState, ValueFormat } from '@binanalyzer/core';
import type { PrefixedAxis, PoolStructTable } from '../src/pool.js';
import type { FamilyDetection } from '../src/family/types.js';

const u16be: ValueFormat = { width: 2, signed: false, endianness: 'big' };
const mk = (address: number, score: number, axisFit = 0): AssociatedTable => ({
  table: { address, rows: 6, cols: 8, format: u16be, score },
  axisFit,
});

describe('rankAndEmit', () => {
  it('preserves constant axes on code-referenced curves, which can be inactive calibrations', () => {
    const format = { width: 1, signed: false, endianness: 'little' } as const;
    const curve: FamilyDetection = { address: 0x40, rows: 2, cols: 1, format,
      score: 0.6, tier: 6, kind: '1d', yAxis: { address: 0x3e, count: 2, format } };
    const [found] = rankAndEmit(new Uint8Array(0x100), [], [], DEFAULT_SCAN_CONFIG, [], [curve]);
    expect(found?.yAxis).toMatchObject({ kind: 'referenced', address: 0x3e, count: 2 });
  });

  it.each(['family', 'structural'] as const)('omits constant detected axes but retains varying and single-cell axes (%s)', (detector) => {
    const bytes = new Uint8Array(0x100);
    const format = { width: 1, signed: false, endianness: 'big' } as const;
    const axis = (address: number): PrefixedAxis => ({ address, count: 4, format, end: address + 4, maximal: true });
    const table = { address: 0x40, rows: 4, cols: 4, format, xAxis: axis(0x10), yAxis: axis(0x20) };
    const cfg = { ...DEFAULT_SCAN_CONFIG, pool: { ...DEFAULT_SCAN_CONFIG.pool, activateMinCount: 1 } };
    const emit = () => rankAndEmit(bytes, [], [], cfg, [axis(0x10)],
      detector === 'family' ? [{ ...table, score: 0.9, tier: 3 }] : [], detector === 'structural' ? [table] : []);
    expect(emit()[0]).toMatchObject({ address: 0x40, rows: 4, cols: 4, detector });
    expect(emit()[0]!.xAxis).toBeUndefined();
    expect(emit()[0]!.yAxis).toBeUndefined();
    bytes.fill(37, 0x10, 0x14);
    bytes.set([0, 1, 2, 2], 0x20);
    expect(emit()[0]!.xAxis).toBeUndefined();
    expect(emit()[0]!.yAxis?.address).toBe(0x20);
    table.xAxis.count = 1;
    expect(emit()[0]!.xAxis?.address).toBe(0x10);
  });

  it('emits valid auto MapDefs sorted by confidence', () => {
    const out = rankAndEmit(new Uint8Array(0), [mk(1000, 0.6), mk(4000, 0.9, 0.8)], [], DEFAULT_SCAN_CONFIG);
    expect(out[0]!.address).toBe(4000);
    expect(out[0]!.provenance).toBe('auto');
    expect(out[0]!.confidence).toBeGreaterThan(out[1]!.confidence!);
    expect(out[0]!.id).toBe('auto-0xfa0-6x8w2be');
  });
  it('drops overlapping lower-confidence candidates', () => {
    // same address block, different col guess — keep only the better one
    const a = mk(1000, 0.9, 0.9);
    const b: AssociatedTable = { table: { address: 1002, rows: 8, cols: 6, format: u16be, score: 0.5 }, axisFit: 0 };
    const out = rankAndEmit(new Uint8Array(0), [a, b], [], DEFAULT_SCAN_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]!.address).toBe(1000);
  });
  it('filters below minConfidence', () => {
    const out = rankAndEmit(new Uint8Array(0), [mk(1000, 0.1)], [], DEFAULT_SCAN_CONFIG);
    expect(out).toEqual([]);
  });

  it('keeps structural axis bytes out of generic table guesses without suppressing shared-axis tables', () => {
    const axis = { address: 4096, count: 32, format: u16be };
    const owner: FamilyDetection = {
      address: 1000, rows: 6, cols: 32, format: u16be, score: 0.9, tier: 0, xAxis: axis,
    };
    const shared: FamilyDetection = { ...owner, address: 2000 };
    const guesses = [mk(4096, 0.99), mk(4160, 0.9), mk(5000, 0.9)];
    const out = rankAndEmit(new Uint8Array(8192), guesses, [], DEFAULT_SCAN_CONFIG, [], [owner, shared]);
    expect(out.map((m) => m.address)).toEqual([1000, 2000, 4160, 5000]);
    // Unverified axis guesses do not acquire ownership of other candidates.
    expect(rankAndEmit(new Uint8Array(8192), guesses, [], DEFAULT_SCAN_CONFIG)
      .some((m) => m.address === 4096)).toBe(true);
  });
});

describe('rankAndEmit anchored ranking', () => {
  // 3×4 u16be map at 128: v(r,c) = 5000 + r*40 + c*100. Row-major cells at 128+2*(r*4+c).
  // colTvAt(cols=4) = 40; colTvAt(cols=5) pulls zero-sea bytes into rows 1-2 → 1666.
  // Shear ratio 1666/40 ≈ 41.6 ≥ shearGateMin 20 → gate passes for the true 3×4 framing.
  const bytes = new Uint8Array(512);
  const cells: number[] = [];
  bytes.set([0, 10, 0, 20, 0, 30, 0, 40, 0, 50, 0, 60, 0, 70], 114);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) cells.push(5000 + r * 40 + c * 100);
  cells.forEach((v, i) => {
    bytes[128 + 2 * i] = v >> 8;
    bytes[128 + 2 * i + 1] = v & 0xff;
  });
  const ax = (address: number, count: number): AxisCandidate => ({
    address, count, format: u16be, direction: 'inc', score: 0.5,
  });
  const cand = (address: number, rows: number, cols: number, score: number): AssociatedTable => ({
    table: { address, rows, cols, format: u16be, score },
    axisFit: 0,
  });

  it('an anchored candidate beats a higher-confidence unanchored sub-block', () => {
    const truth = cand(128, 3, 4, 0.6); // conf 0.42 — anchored via x[114,122)+y[122,128)
    const sub = cand(130, 2, 4, 0.95); // conf ≈0.60 — no axis chain ends at 130
    const out = rankAndEmit(bytes, [sub, truth], [ax(114, 4), ax(122, 3)], DEFAULT_SCAN_CONFIG);
    expect(out).toHaveLength(1); // sub overlaps the kept truth block and is dropped
    expect(out[0]!.address).toBe(128);
    expect(out[0]!.rows).toBe(3);
    expect(out[0]!.xAxis?.kind).toBe('referenced');
    expect(out[0]!.xAxis?.address).toBe(114); // anchor chain emitted as the axes
    expect(out[0]!.yAxis?.address).toBe(122);
  });

  it('within the anchored tier, a shear-passing block beats a shear-failing higher-confidence one', () => {
    const truth = cand(128, 3, 4, 0.6); // shear 41.6 → gate passes
    const short = cand(128, 2, 4, 0.9); // conf 0.57; its cols+1 probe stays in-map → shear ≈3.9, gate fails
    const axes = [ax(114, 4), ax(122, 3), ax(116, 4), ax(124, 2)]; // both candidates exact-anchored
    const out = rankAndEmit(bytes, [short, truth], axes, DEFAULT_SCAN_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]!.rows).toBe(3);
  });

  // Regression (Task A6 `pnpm eval holdout`, seed 8, truth map gt-8-6, 8x14 u16be
  // @0x14a50): a width-1 byte-phase reinterpretation of the SAME bytes as the
  // true width-2 block has more cells (8x22 = 176) but a SMALLER byte span (176
  // bytes vs the truth's 8x14x2 = 224 bytes), and both survive the anchored+
  // shear tier (real DEFAULT_SCAN_CONFIG values below are the actual planted
  // cell/axis values from that failing holdout seed — this is a minimized,
  // from-scratch reproduction run through the real stage 1-5 pipeline, not a
  // hand-faked AssociatedTable). Ranking by cell count let the width-1 alias
  // outrank the true block; the tie-break must compare byte span (spec §4.5's
  // overlap resolution operates on byte spans throughout — this tier must
  // match).
  it('within the anchored+shear tier, a wider byte span beats a narrower one even with fewer cells', () => {
    const rows = 8;
    const cols = 14;
    const cellValues = [
      [6375, 6399, 6425, 6447, 6468, 6491, 6513, 6536, 6559, 6584, 6607, 6629, 6654, 6674],
      [6440, 6467, 6485, 6513, 6535, 6556, 6581, 6601, 6626, 6650, 6669, 6691, 6717, 6740],
      [6505, 6526, 6553, 6575, 6596, 6619, 6644, 6667, 6693, 6710, 6736, 6757, 6785, 6802],
      [6570, 6597, 6617, 6642, 6666, 6688, 6707, 6732, 6755, 6778, 6801, 6821, 6845, 6867],
      [6636, 6659, 6682, 6705, 6727, 6752, 6771, 6797, 6818, 6840, 6863, 6892, 6915, 6935],
      [6699, 6722, 6746, 6769, 6792, 6819, 6839, 6859, 6885, 6910, 6930, 6951, 6975, 6997],
      [6769, 6790, 6811, 6838, 6855, 6882, 6905, 6924, 6950, 6976, 6998, 7018, 7042, 7065],
      [6828, 6856, 6876, 6899, 6922, 6947, 6972, 6989, 7017, 7036, 7064, 7085, 7108, 7127],
    ];
    const xAxisValues = [1180, 1392, 1604, 1816, 2028, 2240, 2452, 2664, 2876, 3088, 3300, 3512, 3724, 3936];
    const yAxisValues = [768, 1138, 1508, 1878, 2248, 2618, 2988, 3358];

    const aliasBytes = new Uint8Array(300);
    aliasBytes.fill(0xff);
    const putU16 = (off: number, v: number): void => {
      aliasBytes[off] = (v >> 8) & 0xff;
      aliasBytes[off + 1] = v & 0xff;
    };
    const xAddr = 16;
    xAxisValues.forEach((v, i) => putU16(xAddr + 2 * i, v));
    const yAddr = xAddr + 2 * cols; // 44
    yAxisValues.forEach((v, i) => putU16(yAddr + 2 * i, v));
    const mapAddr = yAddr + 2 * rows; // 60
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) putU16(mapAddr + 2 * (r * cols + c), cellValues[r]![c]!);

    const regions = classifyRegions(aliasBytes, DEFAULT_SCAN_CONFIG);
    const aliasAxes = scanAxes(aliasBytes, regions, DEFAULT_SCAN_CONFIG);
    const aliasTables = scanTables(aliasBytes, regions, DEFAULT_SCAN_CONFIG);
    const aliasAssoc = associate(aliasTables, aliasAxes, DEFAULT_SCAN_CONFIG);
    const out = rankAndEmit(aliasBytes, aliasAssoc, aliasAxes, DEFAULT_SCAN_CONFIG);

    const truthSpan: [number, number] = [mapAddr, mapAddr + rows * cols * 2];
    const winner = out.find((o) => {
      const s = o.address;
      const e = o.address + o.rows * o.cols * o.format.width;
      return Math.max(s, truthSpan[0]) < Math.min(e, truthSpan[1]);
    });
    expect(winner).toBeDefined();
    expect(winner!.address).toBe(mapAddr);
    expect(winner!.rows).toBe(rows);
    expect(winner!.cols).toBe(cols);
    expect(winner!.format.width).toBe(2);
  });
});

describe('startEdgeOk', () => {
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  // 4x4 quantized map at 64 preceded by high-contrast bytes; smooth interior
  const edgeBytes = new Uint8Array(128);
  edgeBytes.set([135, 35, 90, 35], 60);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) edgeBytes[64 + r * 4 + c] = r + 1;

  it('fires at a data boundary', () => {
    expect(startEdgeOk(edgeBytes, { address: 64, rows: 4, cols: 4, format: u8, score: 0.8 }, 16)).toBe(true);
  });
  it('rejects a sub-block starting inside smooth data', () => {
    expect(startEdgeOk(edgeBytes, { address: 68, rows: 3, cols: 4, format: u8, score: 0.8 }, 16)).toBe(false);
  });
  it('treats an out-of-bounds previous row as an edge', () => {
    expect(startEdgeOk(edgeBytes, { address: 2, rows: 4, cols: 4, format: u8, score: 0.8 }, 16)).toBe(true);
  });
});

describe('rankAndEmit pool tier', () => {
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  // Layout: [8-count axis @301][6-count axis @310] … [6x8 quantized map @400]
  // preceded by contrast bytes; a smoother sub-block overlaps the map.
  const bytes = new Uint8Array(512);
  bytes[300] = 8;
  bytes.set([10, 25, 40, 70, 100, 140, 190, 240], 301);
  bytes[309] = 6;
  bytes.set([20, 60, 100, 140, 180, 220], 310);
  bytes.set([200, 10, 200, 10, 200, 10, 200, 10], 392); // high-contrast boundary row
  for (let r = 0; r < 6; r++) for (let c = 0; c < 8; c++) bytes[400 + r * 8 + c] = 40 + r * 2 + c;
  const pax = (address: number, count: number): PrefixedAxis => ({
    address, count, format: u8, end: address + count, maximal: true,
  });
  const pool = [pax(301, 8), pax(310, 6)];
  const cand = (address: number, rows: number, cols: number, score: number): AssociatedTable => ({
    table: { address, rows, cols, format: u8, score },
    axisFit: 0,
  });
  // activateMinCount 2 for unit-scale pools; production default stays 16
  const cfg = { ...DEFAULT_SCAN_CONFIG, pool: { ...DEFAULT_SCAN_CONFIG.pool, activateMinCount: 2 } };

  it.each([1, 2] as const)('preserves row resets over a smoother transposed width-%i frame', (width) => {
    const b = new Uint8Array(1024).fill(200);
    const format = { width, signed: false, endianness: 'little' } as const;
    const rows = 7, cols = 11, address = 400;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const value = width === 1 ? 1 + Math.min(r, rows - 1 - r) : 2000 + r * 90 + c * 30;
      const at = address + (r * cols + c) * width;
      b[at] = value & 255;
      if (width === 2) b[at + 1] = value >> 8;
    }
    const axes = [pax(300, cols), pax(320, rows)];
    for (const axis of axes) b.set(Array.from({ length: axis.count }, (_, i) => 20 + i * 5), axis.address);
    const truth: AssociatedTable = { table: { address, rows, cols, format, score: 0.75 }, axisFit: 0 };
    const transposed: AssociatedTable = { table: { address, rows: cols, cols: rows, format, score: 0.83 }, axisFit: 0 };
    for (const table of [truth.table, transposed.table]) {
      expect(startEdgeOk(b, table, cfg.pool.edgeMin)).toBe(true);
      expect(endEdgeOk(b, table, cfg.pool.endEdgeMin)).toBe(true);
    }
    for (const candidates of [[truth, transposed], [transposed, truth]]) {
      const out = rankAndEmit(b, candidates, [], cfg, axes);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ address, rows, cols, format,
        xAxis: { address: 300, count: cols }, yAxis: { address: 320, count: rows } });
    }
  });

  it('recognizes row resets that reverse direction without changing step magnitude', () => {
    const b = new Uint8Array(512).fill(200);
    for (let r = 0; r < 7; r++) for (let c = 0; c < 6; c++) b[400 + r * 6 + c] = 40 + r * 4 + c;
    const axes = [pax(300, 6), pax(310, 7)];
    for (const axis of axes) b.set(Array.from({ length: axis.count }, (_, i) => 20 + i * 5), axis.address);
    const out = rankAndEmit(b, [cand(400, 6, 7, 0.95), cand(400, 7, 6, 0.75)], [], cfg, axes);
    expect(out[0]).toMatchObject({ address: 400, rows: 7, cols: 6,
      xAxis: { address: 300 }, yAxis: { address: 310 } });
  });

  it('a pool-anchored edge-passing candidate beats a smoother overlapping sub-block and emits the pool axes', () => {
    const truth = cand(400, 6, 8, 0.7);
    const sub = cand(408, 5, 8, 0.95); // starts inside the map → no start edge
    const out = rankAndEmit(bytes, [sub, truth], [], cfg, pool);
    expect(out[0]!.address).toBe(400);
    expect(out[0]!.rows).toBe(6);
    expect(out[0]!.xAxis?.address).toBe(301);
    expect(out[0]!.yAxis?.address).toBe(310);
    expect(out).toHaveLength(1); // the sub-block overlaps and is dropped
  });

  it('prefers the stronger pair of boundaries over a smoother one-byte shifted frame', () => {
    const b = bytes.slice();
    b.fill(200, 392, 400);
    b.fill(200, 448, 464);
    const truth = cand(400, 6, 8, 0.78);
    const shifted = cand(401, 6, 8, 0.94);
    for (const c of [truth, shifted]) {
      expect(startEdgeOk(b, c.table, cfg.pool.edgeMin)).toBe(true);
      expect(endEdgeOk(b, c.table, cfg.pool.endEdgeMin)).toBe(true);
    }
    expect(rankAndEmit(b, [shifted, truth], [], cfg, pool)[0]?.address).toBe(400);
  });

  it('below activateMinCount the pool is ignored (behavior identical to 4-arg call)', () => {
    const truth = cand(400, 6, 8, 0.7);
    const sub = cand(408, 5, 8, 0.95);
    const withPool = rankAndEmit(bytes, [sub, truth], [], DEFAULT_SCAN_CONFIG, pool); // 2 < 16
    const without = rankAndEmit(bytes, [sub, truth], [], DEFAULT_SCAN_CONFIG);
    expect(withPool).toEqual(without);
  });

  it('labels the pool-anchored candidate detector=pool', () => {
    const truth = cand(400, 6, 8, 0.7);
    const out = rankAndEmit(bytes, [truth], [], cfg, pool);
    expect(out.find((m) => m.address === 400)?.detector).toBe('pool');
  });
});

describe('rankAndEmit detector tier (provenance marker)', () => {
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  const pax = (address: number, count: number): PrefixedAxis => ({
    address, count, format: u8, end: address + count, maximal: true,
  });

  it('labels plain byte candidates detector=generic', () => {
    const out = rankAndEmit(new Uint8Array(0), [mk(1000, 0.9, 0.9)], [], DEFAULT_SCAN_CONFIG);
    expect(out[0]!.detector).toBe('generic');
  });

  it('labels family (code-xref) detections detector=family', () => {
    const fam: FamilyDetection = {
      address: 2000, rows: 4, cols: 4, format: u8, score: 0.1, tier: 0,
      xAxis: { address: 100, count: 4, format: u8 },
      yAxis: { address: 110, count: 4, format: u8 },
    };
    const out = rankAndEmit(new Uint8Array(3000), [], [], DEFAULT_SCAN_CONFIG, [], [fam]);
    expect(out.find((m) => m.address === 2000)?.detector).toBe('family');
  });

  it('labels pool-structural placements detector=structural', () => {
    const cfg = { ...DEFAULT_SCAN_CONFIG, pool: { ...DEFAULT_SCAN_CONFIG.pool, activateMinCount: 1 } };
    const st: PoolStructTable = { address: 500, rows: 4, cols: 4, format: u8, xAxis: pax(100, 4), yAxis: pax(110, 4) };
    const out = rankAndEmit(new Uint8Array(1000), [], [], cfg, [pax(100, 4)], [], [st]);
    expect(out.find((m) => m.address === 500)?.detector).toBe('structural');
  });
});

describe('endEdgeOk', () => {
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  // 4x4 quantized map at 64 with a high-contrast row AFTER it (bottom boundary).
  const afterHi = new Uint8Array(128);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) afterHi[64 + r * 4 + c] = 40 + r * 2 + c;
  afterHi.set([200, 10, 200, 10], 80); // pseudo-row after the block

  it('fires at a bottom data boundary', () => {
    expect(endEdgeOk(afterHi, { address: 64, rows: 4, cols: 4, format: u8, score: 0.8 }, 16)).toBe(true);
  });
  it('rejects a block that ends inside smooth data', () => {
    // same map but smooth continuation after it (zeros) → low bottom contrast
    const afterSmooth = new Uint8Array(128);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) afterSmooth[64 + r * 4 + c] = 40 + r * 2 + c;
    // bytes 80..83 stay 0 → |last row (46..49) − 0| ≈ 47 but internal colTv is 2…
    // make the after-row continue the ramp so contrast is genuinely low:
    afterSmooth.set([48, 49, 50, 51], 80); // ramp continues → Δ ≈ 2 == internal
    expect(endEdgeOk(afterSmooth, { address: 64, rows: 4, cols: 4, format: u8, score: 0.8 }, 16)).toBe(false);
  });
  it('treats an out-of-bounds next row as an edge', () => {
    const tiny = new Uint8Array(8); // 2×4 block fills the buffer → no row after (OOB)
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) tiny[r * 4 + c] = r * 2 + c;
    // lastRowAddr=4; colTvAt(4,2,4) needs 4+8=12 > 8 → undefined → endEdgeOk returns true
    expect(endEdgeOk(tiny, { address: 0, rows: 2, cols: 4, format: u8, score: 0.8 }, 16)).toBe(true);
  });
});

describe('rankAndEmit two-sided edge membership', () => {
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  // True T = 6x8 @400 with BOTH a top (392) and bottom (448) high-contrast row.
  // Spurious S = 4x8 @400 (a sub-block of T): shares T's top edge (passes) but
  // ends at 432 INSIDE T's smooth interior (fails end-edge). S has higher
  // confidence, so with a single top-edge gate S wins the overlap; with the
  // two-sided gate S drops to tier 0 and the true 6x8 wins.
  const bytes = new Uint8Array(512);
  bytes.set([200, 10, 200, 10, 200, 10, 200, 10], 392);            // T top edge
  for (let r = 0; r < 6; r++) for (let c = 0; c < 8; c++) bytes[400 + r * 8 + c] = 40 + r * 2 + c;
  bytes.set([200, 10, 200, 10, 200, 10, 200, 10], 448);            // T bottom edge
  const pax = (address: number, count: number): PrefixedAxis => ({
    address, count, format: u8, end: address + count, maximal: true,
  });
  // pool: count-8 (shared cols), count-6 (T rows), count-4 (S rows)
  const pool = [pax(300, 8), pax(310, 6), pax(318, 4)];
  for (const axis of pool) bytes.set(Array.from({ length: axis.count }, (_, i) => i), axis.address);
  const cand = (address: number, rows: number, cols: number, score: number): AssociatedTable => ({
    table: { address, rows, cols, format: u8, score }, axisFit: 0,
  });
  const cfg = { ...DEFAULT_SCAN_CONFIG, pool: { ...DEFAULT_SCAN_CONFIG.pool, activateMinCount: 2 } };

  it('a two-sided-edge true block beats a higher-confidence single-top-edge sub-block', () => {
    const truth = cand(400, 6, 8, 0.7);  // conf 0.55; passes top+bottom edge → tier 2
    const sub = cand(400, 4, 8, 0.95);   // conf 0.675; passes top, FAILS bottom → tier 0
    const out = rankAndEmit(bytes, [sub, truth], [], cfg, pool);
    expect(out).toHaveLength(1);          // sub overlaps the kept truth block and is dropped
    expect(out[0]!.address).toBe(400);
    expect(out[0]!.rows).toBe(6);
    expect(out[0]!.cols).toBe(8);
    expect(out[0]!.xAxis?.address).toBe(300);
    expect(out[0]!.yAxis?.address).toBe(310);
  });
});

describe('rankAndEmit cluster tier', () => {
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  // A smooth stacked-4-wide field (no high-contrast boundaries anywhere), so a
  // 3×4 block at 128 FAILS both start- and end-edge. A separator-backed cluster
  // candidate must still reach the pool tier on its anchor alone and beat an
  // overlapping higher-confidence normal swallower that has no pool anchor.
  const bytes = new Uint8Array(256);
  for (let i = 96; i < 200; i++) bytes[i] = 40 + Math.floor((i - 96) / 4) * 2 + ((i - 96) % 4);
  const pax = (address: number, count: number): PrefixedAxis => ({
    address, count, format: u8, end: address + count, maximal: true,
  });
  // distinct counts (4 for cols, 3 for rows) so the x=cols / y=rows binding is
  // unambiguous — a square block against two equal-count axes would make x/y
  // tie-break dependent.
  const pool = [pax(100, 4), pax(106, 3)];
  const cfg = { ...DEFAULT_SCAN_CONFIG, pool: { ...DEFAULT_SCAN_CONFIG.pool, activateMinCount: 2 } };
  const clusterCand: AssociatedTable = { table: { address: 128, rows: 3, cols: 4, format: u8, score: 0.7, cluster: true }, axisFit: 0 };
  const swallow: AssociatedTable = { table: { address: 128, rows: 8, cols: 8, format: u8, score: 0.95 }, axisFit: 0 };

  it('a separator-backed cluster candidate reaches the pool tier without a start/end edge', () => {
    const out = rankAndEmit(bytes, [swallow, clusterCand], [], cfg, pool);
    expect(out).toHaveLength(1);           // swallow overlaps the kept cluster block and is dropped
    expect(out[0]!.address).toBe(128);
    expect(out[0]!.rows).toBe(3);
    expect(out[0]!.cols).toBe(4);
    expect(out[0]!.xAxis?.address).toBe(100); // count = cols = 4
    expect(out[0]!.yAxis?.address).toBe(106); // count = rows = 3
  });
});

describe('rankAndEmit — family tier', () => {
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  const famDet = (over: Partial<FamilyDetection> = {}): FamilyDetection => ({
    address: 0x40,
    rows: 4,
    cols: 4,
    format: u8,
    score: 0.05,
    tier: 0,
    xAxis: { address: 0x10, count: 4, format: u8 },
    yAxis: { address: 0x20, count: 4, format: u8 },
    ...over,
  });

  it('emits family detections even below score.minConfidence, with their axes', () => {
    const bytes = new Uint8Array(0x100);
    bytes.set([1, 2, 3, 4], 0x10); bytes.set([1, 2, 3, 4], 0x20);
    const maps = rankAndEmit(bytes, [], [], DEFAULT_SCAN_CONFIG, [], [famDet()]);
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({
      id: 'auto-0x40-4x4w1be',
      address: 0x40,
      rows: 4,
      cols: 4,
      provenance: 'auto',
      confidence: 0.05,
      xAxis: { kind: 'referenced', address: 0x10, count: 4 },
      yAxis: { kind: 'referenced', address: 0x20, count: 4 },
    });
  });

  it('family detections claim their span before byte candidates', () => {
    const bytes = new Uint8Array(0x100);
    bytes.set([1, 2, 3, 4], 0x10);
    for (let i = 0; i < 16; i++) bytes[0x40 + i] = 100 + i; // smooth block for the byte candidate
    const byteCand = {
      table: { address: 0x40, rows: 4, cols: 4, format: u8, score: 0.9 },
      axisFit: 0,
    };
    const maps = rankAndEmit(bytes, [byteCand], [], DEFAULT_SCAN_CONFIG, [], [famDet()]);
    expect(maps.filter((m) => m.address === 0x40)).toHaveLength(1);
    expect(maps[0]!.xAxis?.address).toBe(0x10); // the family framing won
  });

  it('a lower tier outranks a higher score inside the family tier', () => {
    const header = famDet({ rows: 4, cols: 4, score: 0.2, tier: 0 });
    const fallback = famDet({ rows: 2, cols: 8, score: 0.9, tier: 2 });
    // same span (16 bytes at 0x40) → dedup keeps the lower-tier framing despite the lower score
    const maps = rankAndEmit(new Uint8Array(0x100), [], [], DEFAULT_SCAN_CONFIG, [], [fallback, header]);
    expect(maps).toHaveLength(1);
    expect(maps[0]!.rows).toBe(4);
  });

  it('a tight fallback claims the span from a higher-scoring loose pair (the 0x35B8 emission order)', () => {
    const tight = famDet({ rows: 4, cols: 4, score: 0.1, tier: 1 });
    const loose = famDet({ rows: 2, cols: 8, score: 0.9, tier: 2 });
    const maps = rankAndEmit(new Uint8Array(0x100), [], [], DEFAULT_SCAN_CONFIG, [], [loose, tight]);
    expect(maps).toHaveLength(1);
    expect(maps[0]!.rows).toBe(4);
  });

  it('an empty family list leaves output identical (parity seam)', () => {
    const bytes = new Uint8Array(0x100);
    for (let i = 0; i < 16; i++) bytes[0x40 + i] = 100 + i;
    const byteCand = {
      table: { address: 0x40, rows: 4, cols: 4, format: u8, score: 0.9 },
      axisFit: 0.5,
    };
    expect(rankAndEmit(bytes, [byteCand], [], DEFAULT_SCAN_CONFIG, [], [])).toEqual(
      rankAndEmit(bytes, [byteCand], [], DEFAULT_SCAN_CONFIG)
    );
  });

  it('emits a 1-axis MapDef for a 1d FamilyDetection (only yAxis, no xAxis)', () => {
    const bytes = new Uint8Array(0x400);
    bytes.set(Array.from({ length: 12 }, (_, i) => i), 0x40);
    const u8 = { width: 1, signed: false, endianness: 'big' } as const;
    const det: FamilyDetection = { address: 0x100, rows: 12, cols: 1, format: u8,
      score: 0.9, tier: 4, kind: '1d',
      yAxis: { address: 0x40, count: 12, format: u8 } };
    const out = rankAndEmit(bytes, [], [], DEFAULT_SCAN_CONFIG, [], [det], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.rows).toBe(12); expect(out[0]!.cols).toBe(1);
    expect(out[0]!.yAxis?.address).toBe(0x40);
    expect(out[0]!.xAxis).toBeUndefined();
  });

  it('2d FamilyDetections still emit both axes (regression)', () => {
    const bytes = new Uint8Array(0x100);
    bytes.set([1, 2, 3, 4], 0x10); bytes.set([1, 2, 3, 4], 0x20);
    const det = { address: 0x40, rows: 4, cols: 4, format: u8, score: 0.05, tier: 0,
      kind: '2d' as const,
      xAxis: { address: 0x10, count: 4, format: u8 },
      yAxis: { address: 0x20, count: 4, format: u8 } };
    const maps = rankAndEmit(bytes, [], [], DEFAULT_SCAN_CONFIG, [], [det]);
    expect(maps).toHaveLength(1);
    expect(maps[0]!.xAxis?.address).toBe(0x10);
    expect(maps[0]!.yAxis?.address).toBe(0x20);
  });
});

describe('rankAndEmit — curve-detections tier (Phase 3)', () => {
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  const pax = (address: number, count: number): PrefixedAxis => ({
    address, count, format: u8, end: address + count, maximal: true,
  });
  // Pool active at unit scale (detector-tier test precedent).
  const cfg = { ...DEFAULT_SCAN_CONFIG, pool: { ...DEFAULT_SCAN_CONFIG.pool, activateMinCount: 1 } };
  const bytes = new Uint8Array(0x400);
  // smooth block at 0x200 so the generic byte candidate is honest
  for (let i = 0; i < 8; i++) bytes[0x200 + i] = 100 + i;
  // one pool-structural table at 0x300 (4x4 u8, axes 0x100/0x110)
  const st: PoolStructTable = { address: 0x300, rows: 4, cols: 4, format: u8, xAxis: pax(0x100, 4), yAxis: pax(0x110, 4) };
  // one generic candidate overlapping the curve span [0x200, 0x206)
  const generic: AssociatedTable = { table: { address: 0x200, rows: 2, cols: 4, format: u8, score: 0.9 }, axisFit: 0.9 };
  // one curve detection: kind '1d', tier 7, rows 6, cols 1, yAxis only
  bytes.set([1, 2, 3, 4, 5, 6], 0x150);
  const curve: FamilyDetection = {
    address: 0x200, rows: 6, cols: 1, format: u8, score: 0.5, tier: 7, kind: '1d',
    yAxis: { address: 0x150, count: 6, format: u8 },
  };

  it('emits curves after the pool-structural tier: curve claims its span, structural stays, generic is displaced', () => {
    const out = rankAndEmit(bytes, [generic], [], cfg, [pax(0x100, 4)], [], [st], [curve]);
    // (a) the curve emits with detector 'structural', 6×1, yAxis only
    const c = out.find((m) => m.address === 0x200);
    expect(c).toBeDefined();
    expect(c!.detector).toBe('structural');
    expect(c!.rows).toBe(6);
    expect(c!.cols).toBe(1);
    expect(c!.yAxis).toMatchObject({ kind: 'referenced', address: 0x150, count: 6 });
    expect(c!.xAxis).toBeUndefined();
    // (b) the pool-structural table still emits (curves never displace it)
    const s = out.find((m) => m.address === 0x300);
    expect(s).toBeDefined();
    expect(s!.rows).toBe(4);
    expect(s!.cols).toBe(4);
    // (c) the overlapping generic candidate does NOT emit (curve claimed the span first)
    expect(out.filter((m) => m.address === 0x200)).toHaveLength(1);
    expect(out.some((m) => m.address === 0x200 && m.rows === 2 && m.cols === 4)).toBe(false);
  });

  it('omitted param is byte-identical to the 7-arg call (parity seam)', () => {
    // (d) with curveDetections omitted / explicitly empty, output deep-equals the 7-arg call
    const fam: FamilyDetection = {
      address: 0x60, rows: 4, cols: 4, format: u8, score: 0.05, tier: 0,
      xAxis: { address: 0x10, count: 4, format: u8 },
      yAxis: { address: 0x20, count: 4, format: u8 },
    };
    const sevenArg = rankAndEmit(bytes, [generic], [], cfg, [pax(0x100, 4)], [fam], [st]);
    const explicitEmpty = rankAndEmit(bytes, [generic], [], cfg, [pax(0x100, 4)], [fam], [st], []);
    expect(explicitEmpty).toEqual(sevenArg);
  });
});

describe('rankAndEmit — param tier (Switch Phase B)', () => {
  const cfg = DEFAULT_SCAN_CONFIG;
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  const grid: FamilyDetection = {
    address: 0x1000,
    rows: 4,
    cols: 4,
    format: u8,
    score: 0.9,
    tier: 0,
  };
  const param = (address: number, states?: SwitchState[]): FamilyDetection => ({
    address,
    rows: 1,
    cols: 1,
    format: u8,
    score: cfg.family.ms41.paramConfidence,
    tier: 9,
    kind: 'param',
    ...(states !== undefined ? { states } : {}),
  });

  it('emits params LAST with full MapDef contract (id/name/category/detector/states)', () => {
    const st = [{ name: '0x01 (stock)', data: [1] }];
    const out = rankAndEmit(new Uint8Array(0x2000), [], [], cfg, [], [grid, param(0x1800, st)]);
    expect(out).toHaveLength(2);
    expect(out[0]!.address).toBe(0x1000); // family grid first
    expect(out[1]).toMatchObject({
      id: 'auto-0x1800-1x1w1be',
      name: 'Param 0x1800 u8',
      category: 'Code-referenced parameter',
      address: 0x1800,
      rows: 1,
      cols: 1,
      provenance: 'auto',
      detector: 'family',
      confidence: cfg.family.ms41.paramConfidence,
      states: st,
    });
  });

  it('a stateless parameter inside a family grid is suppressed', () => {
    const out = rankAndEmit(new Uint8Array(0x2000), [], [], cfg, [], [grid, param(0x1005)]);
    expect(out).toHaveLength(1); // 1-byte span inside the 16-byte grid → overlapFrac 1 → suppressed
  });

  it('retains a code-read scalar hidden inside a generic table candidate', () => {
    const generic = mk(0x1000, 0.95, 0.9);
    const out = rankAndEmit(new Uint8Array(0x2000), [generic], [], cfg, [], [param(0x1005)]);
    expect(out).toHaveLength(2);
    expect(out[0]!.detector).toBe('generic');
    expect(out[1]!.address).toBe(0x1005);
  });

  it('a STATES-BEARING param inside a kept span is EXEMPT from suppression (Decision 10)', () => {
    const st = [{ name: '0x00 (stock)', data: [0] }, { name: '0x01', data: [1] }];
    const out = rankAndEmit(new Uint8Array(0x2000), [], [], cfg, [], [grid, param(0x1005, st)]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ address: 0x1005, states: st });
    // …and the exempt param still does not move the map it overlaps:
    expect(out[0]!.address).toBe(0x1000);
  });

  it('params never displace earlier tiers (append-only): family emission list is unchanged by params', () => {
    const withoutParams = rankAndEmit(new Uint8Array(0x2000), [], [], cfg, [], [grid]);
    const withParams = rankAndEmit(new Uint8Array(0x2000), [], [], cfg, [], [grid, param(0x1800)]);
    expect(withParams.slice(0, withoutParams.length)).toEqual(withoutParams);
  });

  it('deterministic order: address asc, width asc; overlapping u16-after-u8-at-same-address suppressed', () => {
    const u16 = { width: 2, signed: false, endianness: 'little' } as const;
    const p16: FamilyDetection = { address: 0x1800, rows: 1, cols: 1, format: u16, score: 0.3, tier: 9, kind: 'param' };
    const out = rankAndEmit(new Uint8Array(0x2000), [], [], cfg, [], [param(0x1800), p16, param(0x1900)]);
    expect(out.map((m) => m.id)).toEqual(['auto-0x1800-1x1w1be', 'auto-0x1900-1x1w1be']);
  });
});
