import { describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { isCurveShaped, toCanonicalCurve } from '../src/curve.js';

const base = {
  id: 'm', name: 'M', address: 0x100,
  format: { width: 1, signed: false, endianness: 'big' } as const,
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major' as const, provenance: 'auto' as const,
};
const yAxis = { kind: 'referenced' as const, address: 0x80, count: 6, format: { width: 1, signed: false, endianness: 'big' } as const };

describe('isCurveShaped', () => {
  it('true for N×1 and 1×N, false for grids and 1×1', () => {
    expect(isCurveShaped({ rows: 6, cols: 1 })).toBe(true);
    expect(isCurveShaped({ rows: 1, cols: 6 })).toBe(true);
    expect(isCurveShaped({ rows: 4, cols: 4 })).toBe(false);
    expect(isCurveShaped({ rows: 1, cols: 1 })).toBe(false);
  });
});

describe('toCanonicalCurve', () => {
  it('is identity for an already-canonical N×1 + yAxis curve (same object)', () => {
    const m: MapDef = { ...base, rows: 6, cols: 1, yAxis };
    expect(toCanonicalCurve(m)).toBe(m);
  });
  it('re-orients 1×N + xAxis (the sizex/X-Axis def convention) to N×1 + yAxis', () => {
    const m: MapDef = { ...base, rows: 1, cols: 6, xAxis: yAxis };
    const c = toCanonicalCurve(m);
    expect(c.rows).toBe(6);
    expect(c.cols).toBe(1);
    expect(c.yAxis).toEqual(yAxis);
    expect(c.xAxis).toBeUndefined();
    expect(c.address).toBe(m.address); // byte layout identical — address untouched
  });
  it('is identity for non-curves and for axisless curves in canonical shape', () => {
    const grid: MapDef = { ...base, rows: 4, cols: 4 };
    expect(toCanonicalCurve(grid)).toBe(grid);
    const bare: MapDef = { ...base, rows: 6, cols: 1 };
    expect(toCanonicalCurve(bare)).toBe(bare);
  });
  it('re-orients an axisless 1×N to N×1', () => {
    const m: MapDef = { ...base, rows: 1, cols: 6 };
    const c = toCanonicalCurve(m);
    expect(c.rows).toBe(6);
    expect(c.cols).toBe(1);
    expect(c.yAxis).toBeUndefined();
  });
  it('preserves a degenerate declared axis count untransformed (0x6cc class)', () => {
    const degenerate = { ...yAxis, count: 1 };
    const m: MapDef = { ...base, rows: 1, cols: 16, xAxis: degenerate };
    const c = toCanonicalCurve(m);
    expect(c.rows).toBe(16);
    expect(c.yAxis?.count).toBe(1); // declared count is data, not ours to fix
  });
});
