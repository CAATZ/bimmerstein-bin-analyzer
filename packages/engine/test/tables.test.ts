import { describe, expect, it } from 'vitest';
import { scanTables, colTvAt } from '../src/tables.js';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import type { Region } from '../src/regions.js';

function putU16be(bytes: Uint8Array, offset: number, values: number[]): void {
  values.forEach((v, i) => {
    bytes[offset + 2 * i] = v >> 8;
    bytes[offset + 2 * i + 1] = v & 0xff;
  });
}

/** Smooth 6×8 map: v = 2000 + r*60 + c*15 + deterministic jitter. */
function plantMap(bytes: Uint8Array, offset: number, rows: number, cols: number): void {
  const vals: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      vals.push(2000 + r * 60 + c * 15 + ((r * cols + c) % 3));
    }
  }
  putU16be(bytes, offset, vals);
}

describe('scanTables', () => {
  it('does not grow through an outlier that enlarges the accepted table range', () => {
    const bytes = new Uint8Array(64).fill(200);
    for (let r = 0; r < 6; r++) bytes.fill(50 + r, 16 + r * 4, 20 + r * 4);
    bytes.set([200, 56, 56, 56], 40);
    const cfg = { ...DEFAULT_SCAN_CONFIG, table: { ...DEFAULT_SCAN_CONFIG.table,
      widths: [1] as Array<1>, minCols: 4, maxCols: 4 } };
    const found = scanTables(bytes, [{ start: 0, end: bytes.length, kind: 'data' }], cfg);
    expect(found).toContainEqual(expect.objectContaining({ address: 16, rows: 6, cols: 4 }));
    expect(found.some(t => t.address === 16 && t.rows > 6)).toBe(false);
  });

  it('does not promote an isolated outlier in a flat block to a table', () => {
    const bytes = new Uint8Array(64).fill(50);
    bytes[31] = 51;
    const cfg = { ...DEFAULT_SCAN_CONFIG, table: { ...DEFAULT_SCAN_CONFIG.table,
      widths: [1] as Array<1>, minRows: 16, maxRows: 16, minCols: 4, maxCols: 4 } };
    const regions: Region[] = [{ start: 0, end: bytes.length, kind: 'data' }];
    expect(scanTables(bytes, regions, cfg)).toEqual([]);
    const unweighted = { ...cfg, table: { ...cfg.table, minVariationFraction: 0 } };
    expect(scanTables(bytes, regions, unweighted)).toContainEqual(expect.objectContaining({
      address: 0, rows: 16, cols: 4, score: expect.any(Number),
    }));

    // Quantized maps may be flat across each row but vary along the other axis.
    for (let r = 0; r < 16; r++) bytes.fill(50 + Math.floor(r / 2), r * 4, (r + 1) * 4);
    expect(scanTables(bytes, regions, cfg)).toContainEqual(expect.objectContaining({
      address: 0, rows: 16, cols: 4, format: expect.objectContaining({ width: 1 }),
    }));
    for (let i = 0; i < bytes.length; i++) bytes[i] = 50 + Math.floor((i % 4) / 2);
    expect(scanTables(bytes, regions, cfg)).toContainEqual(expect.objectContaining({
      address: 0, rows: 16, cols: 4, format: expect.objectContaining({ width: 1 }),
    }));
  });

  it('finds a planted 6×8 u16be map with the right column count', () => {
    const bytes = new Uint8Array(1024); // zero sea
    plantMap(bytes, 256, 6, 8);
    const regions: Region[] = [{ start: 0, end: 1024, kind: 'data' }];
    const found = scanTables(bytes, regions, DEFAULT_SCAN_CONFIG);
    const hit = found.find((t) => {
      const start = t.address;
      const end = t.address + t.rows * t.cols * t.format.width;
      return start <= 256 && end >= 256 + 6 * 8 * 2 && t.cols === 8;
    });
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThanOrEqual(DEFAULT_SCAN_CONFIG.table.minTableScore);
  });
  it('finds a 6×8 map whose start offset is NOT a multiple of cols (tight non-aligned adjacency)', () => {
    // Mirrors the scan-canary regression: an ascending "axis-like" run planted
    // immediately before the table, with a length chosen so the table's
    // region-relative start element-index (13) is NOT a multiple of the
    // table's true cols (8) — 13 % 8 === 5. A sweep that only ever visits
    // start offsets that are multiples of cols (0, 8, 16, ...) can never
    // reach element-index 13 and will permanently miss this table.
    const bytes = new Uint8Array(1024); // zero sea
    const axisLen = 13;
    const axisVals: number[] = [];
    for (let i = 0; i < axisLen; i++) axisVals.push(800 + i * 400);
    putU16be(bytes, 0, axisVals);
    const tableOffset = axisLen * 2; // bytes; element-index 13, 13 % 8 = 5
    plantMap(bytes, tableOffset, 6, 8);
    const regions: Region[] = [{ start: 0, end: 1024, kind: 'data' }];
    const found = scanTables(bytes, regions, DEFAULT_SCAN_CONFIG);
    const hit = found.find((t) => {
      const start = t.address;
      const end = t.address + t.rows * t.cols * t.format.width;
      return start <= tableOffset && end >= tableOffset + 6 * 8 * 2 && t.cols === 8 && t.rows === 6;
    });
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThanOrEqual(DEFAULT_SCAN_CONFIG.table.minTableScore);
  });
  it('emits nothing above threshold for high-entropy bytes', () => {
    const bytes = new Uint8Array(2048);
    let s = 42 >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      bytes[i] = (s >>> 16) & 0xff;
    }
    const found = scanTables(bytes, [{ start: 0, end: 2048, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    // random data may fluke small low-score candidates; none should be large AND confident
    const big = found.filter((t) => t.rows * t.cols >= 32 && t.score > 0.7);
    expect(big).toEqual([]);
  });
  it('finds a table at an odd byte offset (phase probing)', () => {
    const bytes = new Uint8Array(1024);
    const vals: number[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) vals.push(2000 + r * 40 + c * 100);
    putU16be(bytes, 301, vals); // odd address
    const found = scanTables(bytes, [{ start: 0, end: 1024, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    const hit = found.find((t) => t.address === 301 && t.rows === 4 && t.cols === 6);
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThanOrEqual(DEFAULT_SCAN_CONFIG.table.minTableScore);
  });

  it('grows quantized integer tables through the relative-smoothness break (growthAbsFloor)', () => {
    const bytes = new Uint8Array(96); // zero-filled; region covers it all
    // Clear top boundary immediately before the table (emission edge filter):
    // without this, the pre-region 0->1 jump is exactly the block's own
    // colTv (1 per row), an ambiguous edge ratio of 1 that the new
    // emissionEdgeMin=2 gate correctly treats as an interior misframe. This
    // fixture is about growthAbsFloor's row-continuation logic, not edge
    // framing, so give it an unambiguous boundary instead.
    bytes[28] = 200; bytes[29] = 200; bytes[30] = 200; bytes[31] = 200;
    // 6x4 u8 map at 32: row r is the constant (r+1): 1,1,1,1 / 2,2,2,2 / … / 6,6,6,6
    for (let r = 0; r < 6; r++) for (let c = 0; c < 4; c++) bytes[32 + r * 4 + c] = r + 1;
    // high-contrast tail (the real knock cluster's stride bytes) so growth stops at row 6
    bytes[56] = 135; bytes[57] = 35; bytes[58] = 90; bytes[59] = 35;
    const found = scanTables(bytes, [{ start: 0, end: 96, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    const hit = found.find((t) => t.address === 32 && t.rows === 6 && t.cols === 4 && t.format.width === 1);
    expect(hit).toBeDefined();
  });

  it('the floor does not accept genuinely discontinuous rows', () => {
    const bytes = new Uint8Array(64);
    // two 4-byte rows at 16: constants 10 and 40 — diff 30 must still break growth
    for (let c = 0; c < 4; c++) { bytes[16 + c] = 10; bytes[20 + c] = 40; }
    const found = scanTables(bytes, [{ start: 0, end: 64, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    expect(found.find((t) => t.address === 16 && t.cols === 4 && t.rows >= 2 && t.format.width === 1)).toBeUndefined();
  });

  it('drops an interior misframe that begins inside smooth data (edge filter)', () => {
    // A long smooth ramp: every 8-wide start grows, but a start that begins
    // MID-ramp has no top boundary (ratio ≈ 1) and must be filtered at
    // emissionEdgeMin; the run's true start (row 0 after a sharp jump) is kept.
    const bytes = new Uint8Array(2048);
    // sharp boundary at 64, then a smooth 12x8 u16be block
    putU16be(bytes, 0, Array.from({ length: 32 }, () => 100)); // flat pre-region
    const vals: number[] = [];
    for (let r = 0; r < 12; r++) for (let c = 0; c < 8; c++) vals.push(3000 + r * 40 + c * 12 + ((r * 8 + c) % 2));
    putU16be(bytes, 64, vals); // boundary jump 100 -> 3000 at offset 64
    const regions: Region[] = [{ start: 0, end: 2048, kind: 'data' }];
    const found = scanTables(bytes, regions, DEFAULT_SCAN_CONFIG);
    // The true block at 64 (strong top edge 100->3000) is emitted:
    expect(found.some((t) => t.address === 64 && t.cols === 8 && t.rows >= 2)).toBe(true);
    // An interior misframe starting one row in (address 64 + 8*2 = 80), which
    // begins inside the smooth ramp (no boundary), is NOT emitted:
    expect(found.some((t) => t.address === 80 && t.cols === 8 && t.rows >= 2)).toBe(false);
    // Sanity: with the filter disabled the interior misframe WOULD appear.
    const noFilter = scanTables(bytes, regions, { ...DEFAULT_SCAN_CONFIG, table: { ...DEFAULT_SCAN_CONFIG.table, emissionEdgeMin: 0 } });
    expect(noFilter.some((t) => t.address === 80 && t.cols === 8 && t.rows >= 2)).toBe(true);
  });
});

describe('colTvAt', () => {
  it('computes mean row-to-row |delta| for a block read from bytes', () => {
    const bytes = new Uint8Array(32);
    // 3×2 u16be at address 4: rows [100,200], [130,240], [170,290]
    putU16be(bytes, 4, [100, 200, 130, 240, 170, 290]);
    // (|130−100|+|240−200|) + (|170−130|+|290−240|) = 70 + 90 = 160; / ((3−1)·2) = 40
    expect(colTvAt(bytes, 4, 3, 2, { width: 2, signed: false, endianness: 'big' })).toBe(40);
  });
  it('returns undefined when out of bounds or degenerate', () => {
    const bytes = new Uint8Array(16);
    const u16be = { width: 2, signed: false, endianness: 'big' } as const;
    expect(colTvAt(bytes, 8, 3, 2, u16be)).toBeUndefined(); // needs 12 bytes past 8
    expect(colTvAt(bytes, 0, 1, 2, u16be)).toBeUndefined(); // rows < 2
    expect(colTvAt(bytes, -2, 3, 2, u16be)).toBeUndefined();
  });
});
