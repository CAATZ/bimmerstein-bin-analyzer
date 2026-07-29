import { describe, expect, it } from 'vitest';
import type { AxisDef, MapDef } from '@binanalyzer/core';
import { axisLabels, gridFromMap, gridFromSelection, seriesFromRange } from '../src/lib/griddata.js';

const U8 = { width: 1, signed: false, endianness: 'little' } as const;
const U16BE = { width: 2, signed: false, endianness: 'big' } as const;
const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);

describe('gridFromSelection', () => {
  it('builds a rows×cols grid with min/max, truncating a partial last row', () => {
    const grid = gridFromSelection(bytes, 4, 4 + 26, 8, U8); // 26 bytes → 3 full rows of 8? no: 3*8=24 ✓
    expect(grid).not.toBeNull();
    expect(grid!.rows).toBe(3);
    expect(grid!.cols).toBe(8);
    expect(grid!.values[0]![0]).toBe(4);
    expect(grid!.values[2]![7]).toBe(4 + 23);
    expect(grid!.min).toBe(4);
    expect(grid!.max).toBe(27);
  });

  it('clamps to the bin end and returns null when less than one row fits', () => {
    expect(gridFromSelection(bytes, 60, 200, 8, U8)).toBeNull(); // 4 bytes < 8 cols
    const grid = gridFromSelection(bytes, 40, 200, 8, U8); // clamped to 24 bytes
    expect(grid!.rows).toBe(3);
  });

  it('honors multi-byte formats', () => {
    const grid = gridFromSelection(bytes, 0, 16, 4, U16BE);
    expect(grid!.rows).toBe(2);
    expect(grid!.values[0]![0]).toBe(0x0001);
    expect(grid!.values[1]![3]).toBe(0x0e0f);
  });
});

describe('gridFromMap', () => {
  it('reads via core readGrid with min/max', () => {
    const map: MapDef = {
      id: 'm', name: 'M', address: 8, rows: 2, cols: 4,
      format: { ...U8 }, scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'manual',
    };
    const grid = gridFromMap(bytes, map);
    expect(grid.values).toEqual([[8, 9, 10, 11], [12, 13, 14, 15]]);
    expect(grid.min).toBe(8);
    expect(grid.max).toBe(15);
  });
});

describe('seriesFromRange', () => {
  it('reads count values and stops at the bin edge', () => {
    expect(seriesFromRange(bytes, 60, 10, U8)).toEqual([60, 61, 62, 63]);
    expect(seriesFromRange(bytes, 0, 3, U16BE)).toEqual([0x0001, 0x0203, 0x0405]);
  });
});

describe('axisLabels', () => {
  it('index labels when the axis is missing', () => {
    expect(axisLabels(bytes, undefined, 3)).toEqual(['0', '1', '2']);
  });

  it('decodes referenced axes and applies the axis scaling', () => {
    const axis: AxisDef = {
      kind: 'referenced', address: 10, count: 3, format: { ...U8 },
      scaling: { factor: 100, offset: 0, units: 'RPM', digits: 0 },
    };
    expect(axisLabels(bytes, axis, 3)).toEqual(['1000', '1100', '1200']);
  });

  it('falls back to index labels when the axis is unreadable', () => {
    const broken: AxisDef = { kind: 'referenced', address: 60, count: 30, format: { ...U8 } };
    expect(axisLabels(bytes, broken, 4)).toEqual(['0', '1', '2', '3']);
  });
});
