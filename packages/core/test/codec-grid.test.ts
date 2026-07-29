import { describe, expect, it } from 'vitest';
import { readGrid, readAxisValues } from '../src/codec.js';
import type { AxisDef, MapDef, ValueFormat } from '../src/types.js';

const u16be: ValueFormat = { width: 2, signed: false, endianness: 'big' };
const base: Omit<MapDef, 'orientation'> = {
  id: 't', name: 't', address: 2, rows: 2, cols: 3, format: u16be,
  scaling: { factor: 1, offset: 0, units: '', digits: 0 }, provenance: 'manual',
};
// bytes: 2 pad bytes then six u16be values 1..6
const bytes = new Uint8Array([0, 0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6]);

describe('readGrid', () => {
  it('row-major: consecutive cells fill rows', () => {
    expect(readGrid(bytes, { ...base, orientation: 'row-major' })).toEqual([[1, 2, 3], [4, 5, 6]]);
  });
  it('col-major: consecutive cells fill columns', () => {
    expect(readGrid(bytes, { ...base, orientation: 'col-major' })).toEqual([[1, 3, 5], [2, 4, 6]]);
  });
});

describe('readAxisValues', () => {
  it('index axis', () => {
    const axis: AxisDef = { kind: 'index', count: 4 };
    expect(readAxisValues(bytes, axis)).toEqual([0, 1, 2, 3]);
  });
  it('literal axis returns a copy', () => {
    const axis: AxisDef = { kind: 'literal', count: 2, values: [10, 20] };
    const out = readAxisValues(bytes, axis);
    expect(out).toEqual([10, 20]);
    out[0] = 99;
    expect(axis.values).toEqual([10, 20]);
  });
  it('referenced axis decodes from bin', () => {
    const axis: AxisDef = { kind: 'referenced', count: 3, address: 2, format: u16be };
    expect(readAxisValues(bytes, axis)).toEqual([1, 2, 3]);
  });
  it('throws on malformed axes', () => {
    expect(() => readAxisValues(bytes, { kind: 'literal', count: 3, values: [1] })).toThrow(RangeError);
    expect(() => readAxisValues(bytes, { kind: 'referenced', count: 3 })).toThrow(RangeError);
  });
});
