import { describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { reviewLayouts, mapWithLayout } from '../src/lib/layoutreview.js';

const u8 = { width: 1, signed: false, endianness: 'big' } as const;
const map: MapDef = { id: 'm', name: 'Table', address: 256, rows: 8, cols: 6,
  format: { width: 2, signed: false, endianness: 'big' }, orientation: 'row-major',
  provenance: 'manual', scaling: { factor: 1, offset: 0, units: '', digits: 0 } };

describe('layout review', () => {
  it('offers byte and word readings of the same bytes, with evidence and deterministic results', () => {
    const bytes = new Uint8Array(512).fill(255);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 12; c++) bytes[256 + r * 12 + c] = 40 + r * 2 + c;
    const before = bytes.slice();
    const found = reviewLayouts(bytes, map);
    expect(found.some(c => c.address === 256 && c.rows === 8 && c.cols === 12 && c.format.width === 1)).toBe(true);
    expect(found.some(c => c.address === 256 && c.rows === 8 && c.cols === 6 && c.format.width === 2)).toBe(true);
    expect(found.every(c => c.address >= 0 && c.address + c.rows * c.cols * c.format.width <= bytes.length)).toBe(true);
    expect(found[0]).toEqual(expect.objectContaining({ topEdge: expect.any(Boolean), bottomEdge: expect.any(Boolean), axisPairs: expect.any(Number) }));
    expect(reviewLayouts(bytes, map)).toEqual(found);
    expect(bytes).toEqual(before);
  });

  it('rejects invalid and non-grid inputs', () => {
    const bytes = new Uint8Array(512);
    expect(reviewLayouts(bytes, { ...map, address: -1 })).toEqual([]);
    expect(reviewLayouts(bytes, { ...map, rows: 1 })).toEqual([]);
    expect(mapWithLayout(map, { ...map, address: 510 }, bytes.length).ok).toBe(false);
  });

  it('preserves compatible literal axes and clears mismatched axes when converting storage layout', () => {
    const current = { ...map, orientation: 'col-major' as const,
      xAxis: { kind: 'literal' as const, count: 8, values: [0,1,2,3,4,5,6,7], name: 'Voltage', libId: 'axis' },
      yAxis: { kind: 'index' as const, count: 6 } };
    const result = mapWithLayout(current, { ...map, cols: 8, rows: 12, format: u8 }, 512);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.xAxis).toEqual(current.xAxis);
    expect(result.value.yAxis).toBeUndefined();
    expect(result.value.orientation).toBe('row-major');
    expect(current.yAxis).toBeDefined();
  });
});
