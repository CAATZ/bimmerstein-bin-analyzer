import { describe, expect, it } from 'vitest';
import { initialPackChecked, type PackRow } from '../src/lib/packapply.js';

const row = (index: number, klass: PackRow['klass']): PackRow => ({
  index,
  name: `T${index}`,
  address: 0x10,
  rows: 1,
  cols: 1,
  klass,
  changedCells: 1,
  cells: [],
  divergedCells: [],
  table: {
    name: `T${index}`,
    address: 0x10,
    rows: 1,
    cols: 1,
    orientation: 'row-major',
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    values: [[1]],
    baseline: [[0]],
  },
});

describe('initialPackChecked', () => {
  it('checks ready, modified and no-change rows', () => {
    const rows = [row(0, 'ready'), row(1, 'modified'), row(2, 'no-change')];
    expect(initialPackChecked(rows)).toEqual({ 0: true, 1: true, 2: true });
  });

  it('leaves an incompatible row UNCHECKED — it can never be applied', () => {
    expect(initialPackChecked([row(0, 'incompatible')])).toEqual({ 0: false });
  });

  it('keys by the row index, not by position, so a filtered view still maps back', () => {
    expect(initialPackChecked([row(7, 'ready')])).toEqual({ 7: true });
  });

  it('returns an empty map for an empty pack rather than throwing', () => {
    expect(initialPackChecked([])).toEqual({});
  });
});
