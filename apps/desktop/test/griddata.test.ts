import { describe, expect, it } from 'vitest';
import type { AxisDef, MapDef } from '@binanalyzer/core';
import { axisLabels, gridFromMap, gridFromSelection, seriesFromRange, sourceAxis, sourceCell, surfaceFromMap } from '../src/lib/griddata.js';

const U8 = { width: 1, signed: false, endianness: 'little' } as const;
const U16BE = { width: 2, signed: false, endianness: 'big' } as const;
const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);

describe('3D physical display', () => {
  it.each(['row-major', 'col-major'] as const)('keeps %s data and named axes together when swapped', (orientation) => {
    const rpm: AxisDef = { kind: 'literal', count: 3, values: [10, 20, 60], name: 'Engine speed', scaling: { factor: 100, offset: 0, units: 'rpm', digits: 0 } };
    const load: AxisDef = { kind: 'literal', count: 2, values: [20, 80], name: 'Load', scaling: { factor: 1, offset: 0, units: '%', digits: 0 } };
    const map: MapDef = {
      id: 'scaled', name: 'Timing', address: 0, rows: 2, cols: 3, format: U8,
      scaling: { factor: -0.5, offset: 30, units: 'deg', digits: 1 }, orientation, provenance: 'manual',
      xAxis: orientation === 'row-major' ? rpm : load,
      yAxis: orientation === 'row-major' ? load : rpm,
    };
    const before = bytes.slice();
    const raw = gridFromMap(bytes, map);
    const grid = surfaceFromMap(bytes, map);
    expect(grid.values).toEqual(raw.values.map((r) => r.map((v) => 30 - v * 0.5)));
    expect(grid.min).toBe(27.5);
    expect(grid.max).toBe(30);
    expect(grid.xAxis).toEqual({ label: 'Engine speed (rpm)', values: ['1000', '2000', '6000'] });
    expect(grid.yAxis).toEqual({ label: 'Load (%)', values: ['20', '80'] });
    expect(grid.valueLabel).toBe('Timing (deg)');
    const swapped = surfaceFromMap(bytes, map, true);
    expect(swapped.xAxis).toEqual(grid.yAxis);
    expect(swapped.yAxis).toEqual(grid.xAxis);
    expect(swapped.values[2]![1]).toBe(grid.values[1]![2]);
    expect(bytes).toEqual(before);
  });

  it('labels unsupported conversions as raw and absent axes as indices', () => {
    const map: MapDef = {
      id: 'raw', name: 'Unknown', address: 0, rows: 2, cols: 2, format: U8,
      scaling: { factor: 9, offset: 8, units: 'V', digits: 2, rawExpression: 'x*x' },
      orientation: 'row-major', provenance: 'manual',
      xAxis: { kind: 'literal', count: 2, values: [2, 3], name: 'Sensor', scaling: { factor: 1, offset: 0, units: 'V', digits: 0, rawExpression: 'x*x' } },
    };
    const grid = surfaceFromMap(bytes, map);
    expect(grid.values).toEqual([[0, 1], [2, 3]]);
    expect(grid.valueLabel).toBe('Unknown (raw; unsupported conversion)');
    expect(grid.xAxis?.label).toBe('Sensor (raw; unsupported conversion)');
    expect(grid.yAxis).toEqual({ label: 'Y (index)', values: ['0', '1'] });
  });
});

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
  it.each(['row-major', 'col-major'] as const)('transposes a rectangular %s table while preserving its byte mapping and axes', (orientation) => {
    const map: MapDef = {
      id: 'm', name: 'M', address: 8, rows: 2, cols: 3,
      format: { ...U16BE }, scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation, provenance: 'manual',
    };
    const before = bytes.slice();
    const original = gridFromMap(bytes, map);
    const shown = gridFromMap(bytes, map, true);
    expect([shown.rows, shown.cols]).toEqual([3, 2]);
    expect(shown.values).toEqual([
      [original.values[0]![0], original.values[1]![0]],
      [original.values[0]![1], original.values[1]![1]],
      [original.values[0]![2], original.values[1]![2]],
    ]);
    for (let r = 0; r < shown.rows; r++) for (let c = 0; c < shown.cols; c++) {
      const cell = sourceCell(r, c, true);
      expect(shown.values[r]![c]).toBe(original.values[cell.row]![cell.col]);
      expect(sourceCell(cell.row, cell.col, true)).toEqual({ row: r, col: c });
    }
    expect(sourceAxis('x', true)).toBe('y');
    expect(sourceAxis('y', true)).toBe('x');
    expect(sourceAxis('x', false)).toBe('x');
    expect([shown.min, shown.max]).toEqual([original.min, original.max]);
    expect(bytes).toEqual(before);
    expect(gridFromMap(bytes, map, false)).toEqual(original);
  });

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
