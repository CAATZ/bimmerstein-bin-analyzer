import { describe, expect, it } from 'vitest';
import type { Region } from '@binanalyzer/engine';
import {
  barFraction, bytesPerRow, cellAtPoint, cellOfOffset, chipsForRows, defaultRawRange,
  hexCell, offsetOfCell, regionKindAt, rowCount, rowOfOffset, visibleRows,
  type GridGeometry,
} from '../src/lib/hexlayout.js';

const g16: GridGeometry = { origin: 0, columns: 16, width: 1, totalBytes: 256 };
const g8w2: GridGeometry = { origin: 3, columns: 8, width: 2, totalBytes: 100 };

describe('grid math', () => {
  it('bytesPerRow / rowCount, including a partial last row and an origin shift', () => {
    expect(bytesPerRow(g16)).toBe(16);
    expect(rowCount(g16)).toBe(16);
    expect(bytesPerRow(g8w2)).toBe(16);
    expect(rowCount(g8w2)).toBe(Math.ceil((100 - 3) / 16)); // 7 rows, last partial
    expect(rowCount({ ...g16, origin: 256 })).toBe(0);
  });

  it('offsetOfCell / cellOfOffset are inverses inside the grid', () => {
    expect(offsetOfCell(g8w2, 0, 0)).toBe(3);
    expect(offsetOfCell(g8w2, 2, 5)).toBe(3 + 2 * 16 + 10);
    expect(cellOfOffset(g8w2, 3 + 2 * 16 + 10)).toEqual({ row: 2, col: 5 });
    expect(cellOfOffset(g8w2, 3 + 2 * 16 + 11)).toEqual({ row: 2, col: 5 }); // second byte of the cell
    expect(cellOfOffset(g8w2, 2)).toBeNull(); // before origin
    expect(cellOfOffset(g16, 256)).toBeNull(); // past the end
  });

  it('rowOfOffset clamps below origin to row 0', () => {
    expect(rowOfOffset(g8w2, 0)).toBe(0);
    expect(rowOfOffset(g8w2, 3 + 16 * 5 + 1)).toBe(5);
  });

  it('visibleRows windows and clamps', () => {
    expect(visibleRows(0, 100, 20, 16)).toEqual({ first: 0, last: 4 });
    expect(visibleRows(35, 100, 20, 16)).toEqual({ first: 1, last: 6 });
    expect(visibleRows(0, 10_000, 20, 3)).toEqual({ first: 0, last: 2 });
    expect(visibleRows(0, 0, 20, 3).last).toBeLessThan(0);
  });
});

describe('regionKindAt (binary search over the engine contract: contiguous, sorted)', () => {
  const regions: Region[] = [
    { start: 0, end: 64, kind: 'empty' },
    { start: 64, end: 192, kind: 'code' },
    { start: 192, end: 256, kind: 'data' },
  ];
  it('hits boundaries exactly (end is exclusive)', () => {
    expect(regionKindAt(regions, 0)).toBe('empty');
    expect(regionKindAt(regions, 63)).toBe('empty');
    expect(regionKindAt(regions, 64)).toBe('code');
    expect(regionKindAt(regions, 191)).toBe('code');
    expect(regionKindAt(regions, 192)).toBe('data');
    expect(regionKindAt(regions, 255)).toBe('data');
    expect(regionKindAt(regions, 256)).toBeUndefined();
    expect(regionKindAt([], 0)).toBeUndefined();
  });
});

describe('value bars + hex text', () => {
  it('defaultRawRange follows the format', () => {
    expect(defaultRawRange({ width: 1, signed: false, endianness: 'little' })).toEqual({ min: 0, max: 255 });
    expect(defaultRawRange({ width: 2, signed: true, endianness: 'big' })).toEqual({ min: -32768, max: 32767 });
  });

  it('barFraction clamps and survives degenerate ranges', () => {
    expect(barFraction(128, { min: 0, max: 256 })).toBeCloseTo(0.5);
    expect(barFraction(-5, { min: 0, max: 255 })).toBe(0);
    expect(barFraction(500, { min: 0, max: 255 })).toBe(1);
    expect(barFraction(7, { min: 7, max: 7 })).toBe(0);
  });

  it('hexCell shows the unsigned bit pattern, padded per width', () => {
    expect(hexCell(255, 1)).toBe('ff');
    expect(hexCell(-1, 1)).toBe('ff');
    expect(hexCell(-1, 2)).toBe('ffff');
    expect(hexCell(0x0a0b, 2)).toBe('0a0b');
    expect(hexCell(5, 4)).toBe('00000005');
  });
});

describe('hit testing + chips', () => {
  const m = { gutterWidth: 88, cellWidth: 30, rowHeight: 20 };
  it('cellAtPoint maps CSS coordinates (incl. scroll) to cells and rejects the gutter', () => {
    expect(cellAtPoint(g16, m, 88, 0)).toEqual({ row: 0, col: 0 });
    expect(cellAtPoint(g16, m, 88 + 30 * 3 + 5, 20 * 4 + 3)).toEqual({ row: 4, col: 3 });
    expect(cellAtPoint(g16, m, 50, 0)).toBeNull(); // gutter
    expect(cellAtPoint(g16, m, 88 + 30 * 16, 0)).toBeNull(); // right of the grid
    expect(cellAtPoint(g16, m, 88, 20 * 16)).toBeNull(); // below the last row
  });

  it('chipsForRows returns chips only for maps whose start lands in the visible rows', () => {
    const list = [
      { id: 'a', name: 'A', address: 0x10, potential: false },
      { id: 'b', name: 'B', address: 0x95, potential: true },
      { id: 'c', name: 'C', address: 0xf0, potential: true },
    ];
    const chips = chipsForRows(list, g16, 0, 9);
    expect(chips.map((c) => c.id)).toEqual(['a', 'b']);
    expect(chips[0]).toEqual({ id: 'a', name: 'A', row: 1, col: 0, potential: false });
    expect(chips[1]).toEqual({ id: 'b', name: 'B', row: 9, col: 5, potential: true });
  });
});
