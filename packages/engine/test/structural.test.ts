import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import { scanPrefixedAxes } from '../src/pool.js';
import { classifyRegions } from '../src/regions.js';
import { poolStructuralHeaderCount, poolStructuralActive, poolStructuralTables, STRUCT_MAX_BIN_LEN } from '../src/structural.js';

const cfg = DEFAULT_SCAN_CONFIG;
const w16 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };

// Plant one [xPfx][xCells][yPfx][yCells] chained pair + a header'd table at `tableAt`.
// Returns the table's expected dims/axes. Deterministic, no randomness.
function plantTable(b: Uint8Array, axAt: number, cols: number, rows: number, tableAt: number) {
  const xPfx = axAt; b[xPfx] = cols; const xData = xPfx + 1;
  for (let i = 0; i < cols; i++) b[xData + i] = 10 + i * 3;
  const yPfx = xData + cols; b[yPfx] = rows; const yData = yPfx + 1;
  for (let i = 0; i < rows; i++) b[yData + i] = 12 + i * 4;
  w16(b, tableAt - 4, xPfx);
  w16(b, tableAt - 2, yPfx);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) b[tableAt + r * cols + c] = 40 + r * 2 + c * 3;
  return { xData, yData };
}

describe('poolStructuralHeaderCount', () => {
  it('counts a valid backward file-offset header and rejects scattered / equal / forward pointers', () => {
    const b = new Uint8Array(0x2000);
    plantTable(b, 0x100, 8, 6, 0x400);           // valid header at 0x400
    // scattered pair (|xPtr-yPtr| > pairSpan): plant axes far apart, header at 0x800
    b[0x100 + 0] = 8; // reuse the valid axes but forge a header pointing far apart
    w16(b, 0x800 - 4, 0x100);   // xPtr near
    w16(b, 0x800 - 2, 0x700);   // yPtr far (|diff| = 0x600 > pairSpan 64) -> rejected
    expect(poolStructuralHeaderCount(b, cfg)).toBe(1);
  });
});

describe('poolStructuralActive', () => {
  it('is false on a random-ish blob below the gate and true once >= gate headers exist', () => {
    const few = new Uint8Array(0x2000);
    plantTable(few, 0x100, 8, 6, 0x400);
    const prefFew = scanPrefixedAxes(few, classifyRegions(few, cfg), cfg);
    expect(poolStructuralActive(few, prefFew, cfg)).toBe(false); // 1 header < 32

    const many = new Uint8Array(0x4000);
    let ax = 0x80, tp = 0x1004;
    for (let k = 0; k < 40; k++) { plantTable(many, ax, 6, 5, tp); ax += 6 + 5 + 4; tp += 6 * 5 + 4; }
    const prefMany = scanPrefixedAxes(many, classifyRegions(many, cfg), cfg);
    expect(poolStructuralHeaderCount(many, cfg)).toBeGreaterThanOrEqual(32);
    expect(poolStructuralActive(many, prefMany, cfg)).toBe(true);
  });

  it('is false at or above the size ceiling even with a dense header layout', () => {
    const big = new Uint8Array(STRUCT_MAX_BIN_LEN); // 0x18000
    let ax = 0x80, tp = 0x1004;
    for (let k = 0; k < 40; k++) { plantTable(big, ax, 6, 5, tp); ax += 6 + 5 + 4; tp += 6 * 5 + 4; }
    const pref = scanPrefixedAxes(big, classifyRegions(big, cfg), cfg);
    expect(poolStructuralActive(big, pref, cfg)).toBe(false);
    expect(poolStructuralTables(big, pref, cfg)).toEqual([]);
  });
});

describe('poolStructuralTables — header path', () => {
  it('does not let two constant axis runs inside word data establish a byte-table boundary', () => {
    const b = new Uint8Array(0x4000);
    const at = 0x2000;
    const { xData, yData } = plantTable(b, 0x100, 16, 16, at);
    b.fill(0, xData, xData + 16); b.fill(0, yData, yData + 16);
    for (let i = 0; i < 256; i++) w16(b, at + i * 2, 1000 + i * 40);
    b[0x180] = 3; b[0x280] = 9;
    // Cell values can point at unrelated counts followed by zero-filled bytes.
    w16(b, at + 256, 0x180); w16(b, at + 258, 0x280);
    const table = poolStructuralTables(b, [], cfg, true).find(t => t.address === at);
    expect(table).toMatchObject({ rows: 16, cols: 16, format: { width: 2, endianness: 'little' } });
  });

  it('uses an adjacent axis prefix to resolve an ambiguous byte/word axis', () => {
    const b = new Uint8Array(0x2000);
    b.set([4, 0, 16, 18, 24, 35, 48, 52, 80, 69], 0x100);
    b.set([4, 0, 100, 0, 200, 0, 44, 1, 144, 1], 0x10a);
    w16(b, 0x3fc, 0x100); w16(b, 0x3fe, 0x10a);
    b.set(Array.from({ length: 16 }, (_, i) => 30 + i), 0x400);
    const table = poolStructuralTables(b, [], cfg, true).find(t => t.address === 0x400);
    expect(table?.xAxis).toMatchObject({ address: 0x102, count: 4, format: { width: 2 } });
  });

  it.each([1, 2] as const)('uses a following pair of curve descriptors to pin the final grid width (%i)', (width) => {
    const b = new Uint8Array(0x3000);
    const { yData } = plantTable(b, 0x100, 4, 6, 0x800);
    const end = 0x800 + 24 * width;
    b.fill(50, 0x800, end);
    for (const at of [end, end + 8]) {
      w16(b, at, yData - 1);
      b.fill(60, at + 2, at + 8);
    }
    const table = poolStructuralTables(b, [], cfg, true).find(t => t.address === 0x800);
    expect(table?.format.width).toBe(width);
    if (width === 1) {
      b.fill(0, end + 8, end + 10); // a lone curve pointer is insufficient
      expect(poolStructuralTables(b, [], cfg, true).find(t => t.address === 0x800)?.format.width).toBe(2);
    }
  });

  it.each([1, 2] as const)('prefers a following grid header over curve-only packing at the other width (%i)', (width) => {
    const b = new Uint8Array(0x3000);
    const at = 0x800, cells = 24;
    const { yData } = plantTable(b, 0x100, 4, 6, at);
    b.fill(50, at, at + cells * 2);
    const next = at + cells * width + 4;
    plantTable(b, 0x140, 4, 4, next);
    const otherEnd = at + cells * (3 - width);
    for (const curve of [otherEnd, otherEnd + 8]) {
      w16(b, curve, yData - 1);
      b.fill(60, curve + 2, curve + 8);
    }
    const out = poolStructuralTables(b, [], cfg, true);
    expect(out.find(t => t.address === at)?.format.width).toBe(width);
    expect(out.some(t => t.address === next)).toBe(true);
  });

  it('prefers a nearby axis pair over an overlapping header forged by small cell values', () => {
    const b = new Uint8Array(0x3000);
    b.set([2, 1, 2], 0x101); // an unrelated valid axis
    for (const at of [0x1000, 0x1044, 0x1088]) {
      plantTable(b, 0x200, 4, 16, at);
      for (let r = 0; r < 16; r++) for (let c = 0; c < 4; c++) {
        b[at + r * 4 + c] = r < 2 ? 1 : 1 + (r + c) % 2;
      }
    }
    const out = poolStructuralTables(b, [], cfg, true);
    expect(out).toContainEqual(expect.objectContaining({ address: 0x1000, rows: 16, cols: 4,
      format: expect.objectContaining({ width: 1 }) }));
    expect(out.some(t => t.address === 0x1002)).toBe(false);
  });

  it('does not use curve boundaries to admit an isolated scattered grid header', () => {
    const b = new Uint8Array(0x3000);
    const { yData } = plantTable(b, 0x100, 4, 6, 0x800);
    b.set(b.slice(yData - 1, yData + 6), 0x700);
    w16(b, 0x7fe, 0x700);
    for (const at of [0x818, 0x820]) {
      w16(b, at, 0x700);
      b.fill(60, at + 2, at + 8);
    }
    expect(poolStructuralTables(b, [], cfg, true).some(t => t.address === 0x800)).toBe(false);
  });

  it('uses a neighboring packed header to corroborate distant shared axes, including the last table', () => {
    const b = new Uint8Array(0x4000);
    const at = 0x2000, cols = 6, rows = 4, size = cols * rows;
    const { xData, yData } = plantTable(b, 0x100, cols, rows, at);
    b.set(b.slice(yData - 1, yData + rows), 0x700);
    w16(b, at - 2, 0x700);
    const next = at + size + 4;
    b.set(b.slice(at - 4, at + size), next - 4);
    expect(poolStructuralHeaderCount(b, cfg)).toBe(0); // activation stays conservative
    const out = poolStructuralTables(b, [], cfg, true);
    for (const address of [at, next]) {
      expect(out).toContainEqual(expect.objectContaining({ address, rows, cols,
        format: expect.objectContaining({ width: 1 }),
        xAxis: expect.objectContaining({ address: xData }),
        yAxis: expect.objectContaining({ address: 0x701 }),
      }));
    }
    b.fill(0, next - 4, next); // an isolated scattered header has no packing evidence
    expect(poolStructuralTables(b, [], cfg, true).some(t => t.address === at)).toBe(false);
  });

  it('allows one alignment byte after odd-sized data when selecting width', () => {
    const b = new Uint8Array(0x4000);
    const at = 0x2000, size = 7 * 5;
    plantTable(b, 0x100, 5, 7, at);
    b.fill(0x42, at, at + size * 2);
    plantTable(b, 0x140, 4, 4, at + size + 1 + 4);
    expect(poolStructuralTables(b, [], cfg, true).find(t => t.address === at)?.format.width).toBe(1);
  });

  it.each([false, true])('keeps a packed word table when its data also decodes as a header (scattered axes: %s)', (scattered) => {
    const b = new Uint8Array(0x4000);
    const at = 0x2000, size = 6 * 4 * 2;
    const { yData } = plantTable(b, 0x100, 6, 4, at);
    if (scattered) {
      b.set(b.slice(yData - 1, yData + 4), 0x700);
      w16(b, at - 2, 0x700);
    }
    for (let i = 0; i < 24; i++) w16(b, at + i * 2, 100 + i * 5);
    const next = at + size + 4;
    plantTable(b, 0x140, 4, 4, next);
    // A false header in the last row must not become the packing boundary.
    plantTable(b, 0x180, 6, 4, 0x2800);
    b.set(b.slice(0x2800 - 4, 0x2800), at + size - 12);
    if (scattered) {
      plantTable(b, 0x1c0, 2, 2, 0x2900);
      b.set(b.slice(0x2900 - 4, 0x2900), at + 8);
    }
    const out = poolStructuralTables(b, [], cfg, true);
    expect(out).toContainEqual(expect.objectContaining({ address: at, rows: 4, cols: 6,
      format: expect.objectContaining({ width: 2 }) }));
    expect(out.some(t => t.address === at + size - 8)).toBe(false);
    expect(out.some(t => t.address === next)).toBe(true);
  });

  it('does not let coincidentally packed headers inside smooth data outrank the whole table', () => {
    const b = new Uint8Array(0x4000);
    const at = 0x2000;
    plantTable(b, 0x100, 16, 16, at);
    for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) w16(b, at + (r * 16 + c) * 2, 100 + r * 10 + c * 3);
    plantTable(b, 0x180, 2, 2, 0x2800);
    const fakeHeader = b.slice(0x2800 - 4, 0x2800);
    b.set(fakeHeader, at + 100);
    b.set(fakeHeader, at + 108); // a 2x2 byte table would fit between these
    expect(poolStructuralTables(b, [], cfg, true)).toContainEqual(expect.objectContaining({
      address: at, rows: 16, cols: 16, format: expect.objectContaining({ width: 2 }),
    }));
  });

  it('excludes the next table header when choosing a packed table width', () => {
    const b = new Uint8Array(0x4000);
    const at = 0x3000;
    plantTable(b, 0x100, 6, 5, at);
    b.fill(0x42, at, at + 6 * 5 * 2);
    plantTable(b, 0x140, 6, 5, at + 6 * 5 * 2 + 4);
    // Both widths see constant cells. Only width 2 fills the data span up
    // to the next four-byte header; its bytes are not part of this table.
    const out = poolStructuralTables(b, [], cfg, true);
    expect(out.find(t => t.address === at)?.format.width).toBe(2);
  });

  it('recovers a header-backed table with EXACT dims + axis addresses', () => {
    const b = new Uint8Array(0x4000);
    let ax = 0x80, tp = 0x1004;
    const exp: { at: number; cols: number; rows: number; xData: number; yData: number }[] = [];
    for (let k = 0; k < 40; k++) { const cols = 6, rows = 5; const { xData, yData } = plantTable(b, ax, cols, rows, tp); exp.push({ at: tp, cols, rows, xData, yData }); ax += cols + rows + 4; tp += cols * rows + 4; }
    const pref = scanPrefixedAxes(b, classifyRegions(b, cfg), cfg);
    const out = poolStructuralTables(b, pref, cfg);
    const first = exp[0]!;
    const hit = out.find((t) => t.address === first.at);
    expect(hit).toBeDefined();
    expect([hit!.rows, hit!.cols]).toEqual([first.rows, first.cols]);
    expect(hit!.xAxis.address).toBe(first.xData);
    expect(hit!.yAxis.address).toBe(first.yData);
  });

  it('is deterministic under a shuffled prefixed-axis input, with both Component A and Component C candidates live', () => {
    const b = new Uint8Array(0x4000);
    let ax = 0x80, tp = 0x1004;
    for (let k = 0; k < 40; k++) { plantTable(b, ax, 6, 5, tp); ax += 6 + 5 + 4; tp += 6 * 5 + 4; }
    // Also plant a genuine Component C run so resolve() is exercised on a
    // MIXED tier-0 + tier-2 candidate set, not tier-0 alone (the original
    // form of this test never generated a single tile candidate).
    plantPackedRun(b, 0x2600, 8, 10, 0x2800, 4);
    const pref = scanPrefixedAxes(b, classifyRegions(b, cfg), cfg);
    const canon = (ts: ReturnType<typeof poolStructuralTables>) => ts.map((t) => `${t.address}:${t.rows}x${t.cols}:${t.format.width}:${t.xAxis.address}:${t.yAxis.address}`).join('|');
    const a = canon(poolStructuralTables(b, pref, cfg));
    const shuffled = [...pref].reverse();
    const c = canon(poolStructuralTables(b, shuffled, cfg));
    expect(c).toBe(a);
    // Sanity: the Component C run is actually present in this fixture (else
    // the check above would be vacuously testing tier-0 alone again).
    expect(a).toContain(`${0x2800}:10x8:1:`);
  });

  it('resolves an EXACT frameScore tie to the smaller width regardless of config.table.widths order', () => {
    // A flat (constant-valued) header-backed table scores IDENTICALLY (0.1,
    // the flat floor) at width 1 and width 2 — a genuine, guaranteed tie with
    // no "exact next-header packing" bonus on either side (no header follows
    // it), isolating headerCandidates' documented "then smaller width"
    // tie-break as the sole remaining discriminator. The constant fill must
    // cover rows*cols*2 bytes (not just rows*cols): a width-2 read spans
    // twice the byte range of a width-1 read, so filling only rows*cols bytes
    // leaves the back half of the width-2 window on unwritten (zero) bytes —
    // a real boundary jump, not a genuine tie — from every byte in the
    // widest format's window being the SAME constant value.
    const build = () => {
      const b = new Uint8Array(0x4000);
      let ax = 0x80, tp = 0x1004;
      for (let k = 0; k < 40; k++) { plantTable(b, ax, 6, 5, tp); ax += 6 + 5 + 4; tp += 6 * 5 + 4; }
      const flatAt = 0x3000;
      const xPfx = ax; b[xPfx] = 6; const xData = xPfx + 1;
      for (let i = 0; i < 6; i++) b[xData + i] = 10 + i * 3;
      const yPfx = xData + 6; b[yPfx] = 5; const yData = yPfx + 1;
      for (let i = 0; i < 5; i++) b[yData + i] = 12 + i * 4;
      w16(b, flatAt - 4, xPfx);
      w16(b, flatAt - 2, yPfx);
      for (let i = 0; i < 6 * 5 * 2; i++) b[flatAt + i] = 0x42; // constant -> flat, ties at every width
      return { b, flatAt };
    };
    const { b, flatAt } = build();
    const pref = scanPrefixedAxes(b, classifyRegions(b, cfg), cfg);
    const runWith = (widths: Array<1 | 2 | 4>) => {
      const config = { ...cfg, table: { ...cfg.table, widths } };
      return poolStructuralTables(b, pref, config).find((t) => t.address === flatAt);
    };
    // Shuffle the ACTUAL ordering-sensitive input: config.table.widths.
    const hitWideFirst = runWith([2, 1]); // width 2 evaluated before the tied width 1
    const hitNarrowFirst = runWith([1, 2]); // width 1 evaluated before the tied width 2
    expect(hitWideFirst).toBeDefined();
    expect(hitNarrowFirst).toBeDefined();
    // If the "w < best.w" tie-break were removed, [2,1] order would keep the
    // first-seen width (2) on the tie instead of replacing it, diverging from
    // [1,2] order's answer (1) — this assertion would then fail.
    expect(hitWideFirst!.format.width).toBe(1);
    expect(hitNarrowFirst!.format.width).toBe(1);
  });
});

// A headerless PACKED custom run: chained plateau pair (x.end == y's prefix),
// then N smooth RxC tables back-to-back, NO 4-byte headers.
function plantPackedRun(b: Uint8Array, axAt: number, cols: number, rows: number, runAt: number, n: number) {
  // chained plateau axes: [xPfx][xCells (strict then plateau)][yPfx][yCells]
  const xPfx = axAt; b[xPfx] = cols; const xData = xPfx + 1;
  for (let i = 0; i < cols; i++) b[xData + i] = i < cols - 2 ? 10 + i * 4 : 10 + (cols - 3) * 4; // plateau tail
  const yPfx = xData + cols; b[yPfx] = rows; const yData = yPfx + 1;
  for (let i = 0; i < rows; i++) b[yData + i] = i < rows - 2 ? 12 + i * 5 : 12 + (rows - 3) * 5;
  let off = runAt;
  for (let t = 0; t < n; t++) { for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) b[off + r * cols + c] = 30 + r * 2 + c * 2 + t; off += rows * cols; }
  return { xData, yData };
}

describe('poolStructuralTables — packed tiling (Component C)', () => {
  it.each([1, 2] as const)('uses the chained row/column axis order when a square packed table cannot distinguish roles by smoothness (width %i)', (width) => {
    const bytes = Uint8Array.from({ length: 0x4000 }, (_, i) => (i * 73 + 19) % 251);
    bytes.fill(0xff, 0, 0x2600); // table values must not also point into plausible low-address axes
    const at = 0x2800, count = 20, size = count * count * width;
    const { xData: rowAxis, yData: colAxis } = plantPackedRun(bytes, 0x2600, count, count, at, 4);
    bytes.fill(0xff, at - count * width, at);
    for (let t = 0; t < 4; t++) for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) {
      const offset = at + t * size + (r * count + c) * width;
      const value = 100 + r * 2 + c * 3 + t;
      if (width === 2) w16(bytes, offset, value); else bytes[offset] = value;
    }
    const found = poolStructuralTables(bytes, [], cfg, true);
    for (let t = 0; t < 4; t++) expect(found).toContainEqual(expect.objectContaining({
      address: at + t * size, rows: count, cols: count,
      format: expect.objectContaining({ width }),
      xAxis: expect.objectContaining({ address: colAxis }),
      yAxis: expect.objectContaining({ address: rowAxis }),
    }));
  });

  it('preserves explicit square-table header roles even when their storage order differs from a headerless chain', () => {
    const bytes = new Uint8Array(0x2000);
    const { xData, yData } = plantTable(bytes, 0x100, 8, 8, 0x500);
    expect(poolStructuralTables(bytes, [], cfg, true)).toContainEqual(expect.objectContaining({
      address: 0x500, xAxis: expect.objectContaining({ address: xData }), yAxis: expect.objectContaining({ address: yData }),
    }));
  });

  it.each([1, 2] as const)('pins every packed table to the leading boundary instead of clipping preceding bytes (width %i)', (width) => {
    const b = new Uint8Array(0x4000);
    const runAt = 0x2800;
    const cols = 8, rows = 10, size = rows * cols * width;
    plantPackedRun(b, 0x2600, cols, rows, runAt, 4);
    b.fill(0xff, runAt - 64, runAt);
    for (let t = 0; t < 4; t++) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const at = runAt + t * size + (r * cols + c) * width;
      const value = 100 + r * 2 + c * 3 + t;
      if (width === 2) w16(b, at, value); else b[at] = value;
    }
    const out = poolStructuralTables(b, [], cfg, true);
    const inRun = out.filter(t => t.address >= runAt - size && t.address < runAt + 4 * size).sort((a, b) => a.address - b.address);
    expect(inRun.map(t => [t.address, t.rows, t.cols, t.format.width])).toEqual(
      Array.from({ length: 4 }, (_, i) => [runAt + i * size, rows, cols, width]));
  });

  it('recovers a >= structTileMinRun packed custom run bound to a tight plateau pair', () => {
    const b = new Uint8Array(0x4000);
    // header density to open the gate
    let ax = 0x80, tp = 0x1004;
    for (let k = 0; k < 40; k++) { plantTable(b, ax, 6, 5, tp); ax += 6 + 5 + 4; tp += 6 * 5 + 4; }
    // a headerless packed run of 4 tables (10x8) elsewhere
    const runAt = 0x2800;
    const { } = plantPackedRun(b, 0x2600, 8, 10, runAt, 4);
    const pref = scanPrefixedAxes(b, classifyRegions(b, cfg), cfg);
    const out = poolStructuralTables(b, pref, cfg);
    const inRun = out.filter((t) => t.address >= runAt && t.address < runAt + 4 * 10 * 8 && t.rows === 10 && t.cols === 8);
    expect(inRun.length).toBeGreaterThanOrEqual(cfg.pool.structTileMinRun);
  });

  it('does NOT emit a tile run shorter than structTileMinRun', () => {
    const b = new Uint8Array(0x4000);
    let ax = 0x80, tp = 0x1004;
    for (let k = 0; k < 40; k++) { plantTable(b, ax, 6, 5, tp); ax += 6 + 5 + 4; tp += 6 * 5 + 4; }
    const runAt = 0x2800;
    plantPackedRun(b, 0x2600, 8, 10, runAt, 2); // only 2 tiles (< min-run 3)
    const pref = scanPrefixedAxes(b, classifyRegions(b, cfg), cfg);
    const out = poolStructuralTables(b, pref, cfg);
    const inRun = out.filter((t) => t.address >= runAt && t.address < runAt + 2 * 10 * 8 && t.rows === 10 && t.cols === 8);
    expect(inRun.length).toBe(0);
  });
});

// NEGATIVE CONTROL: every fixture in the gate-margin suite below is >=
// STRUCT_MAX_BIN_LEN (0x18000), so poolStructuralHeaderCount short-circuits on
// the SIZE CEILING alone (`if (bytes.length >= STRUCT_MAX_BIN_LEN) return 0`)
// and never actually exercises the header-decode loop. This test is
// deliberately SUB-ceiling (like a real cal partial) so the decode loop runs
// for real, proving the gate does not spuriously activate on non-MS41
// direct-framed noise. Seeded LCG (no Math.random — engine determinism).
describe('poolStructuralHeaderCount — negative control (sub-ceiling random blob)', () => {
  it('is 0 on a deterministic random ~24KB blob (no planted headers)', () => {
    let seed = (0xdead_beef * 2654435761) >>> 0;
    const rng = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const size = 0x6000; // sub-ceiling, matches the partial-synthetic fixture size
    expect(size).toBeLessThan(STRUCT_MAX_BIN_LEN);
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) b[i] = Math.floor(rng() * 256);
    expect(poolStructuralHeaderCount(b, cfg)).toBe(0);
    expect(poolStructuralActive(b, [], cfg)).toBe(false);
  });
});

// GATE-MARGIN guard: the detector must be INERT (0 headers) on every committed
// NON-partial fixture. Catches foreign-constant drift (e.g. axis.maxCount) that
// would silently open the gate on a scrambled full read. Real MS41 bins are
// gitignored — skip them when absent; the synthetic fixtures are always present.
describe('gate margin on committed non-partial fixtures', () => {
  const nonPartials = [
    '../../../fixtures/synthetic/synth-1.bin',
    '../../../fixtures/synthetic/synth-2.bin',
    '../../../fixtures/synthetic/synth-pool-101.bin',
    '../../../fixtures/synthetic/synth-pool-103.bin',
    '../../../fixtures/ms41/E36 M3 Stock Full Read.bin',
    '../../../fixtures/ms41/MS41.3 S52 Stock Full Read.bin',
  ];
  for (const rel of nonPartials) {
    it(`header count is 0 on ${rel.split('/').pop()}`, () => {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(readFileSync(new URL(rel, import.meta.url))); }
      catch { return; } // gitignored real bin absent locally — skip
      expect(poolStructuralHeaderCount(bytes, cfg)).toBe(0);
    });
  }
});
