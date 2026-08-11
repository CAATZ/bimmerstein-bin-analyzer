import { describe, expect, it } from 'vitest';
import type { EditJournal, MapDef } from '@binanalyzer/core';
import { isCellChanged, originalGrid } from '../src/lib/diffcells.js';

const journal = (...offsets: number[]): EditJournal =>
  new Map(offsets.map((o) => [o, { original: 0, current: 1 }]));

describe('isCellChanged', () => {
  it('is true when ANY byte of a multi-byte cell changed', () => {
    expect(isCellChanged(journal(7), 6, 2)).toBe(true);
    expect(isCellChanged(journal(6), 6, 2)).toBe(true);
  });

  it('is false when no byte of the cell changed', () => {
    expect(isCellChanged(journal(8), 6, 2)).toBe(false);
    expect(isCellChanged(new Map(), 6, 2)).toBe(false);
  });

  it('does not treat an adjacent cell as changed', () => {
    expect(isCellChanged(journal(5), 6, 1)).toBe(false);
  });
});

describe('originalGrid', () => {
  const m: MapDef = {
    id: 'm', name: 'm', address: 0, rows: 1, cols: 4,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major', provenance: 'manual',
  };

  it('rebuilds the file-as-opened values from working + journal, never bin.bytes', () => {
    const working = Uint8Array.from({ length: 8 }, (_, i) => i);
    working[2] = 0x99; // an edit
    const j: EditJournal = new Map([[2, { original: 2, current: 0x99 }]]);
    expect(originalGrid(working, j, m).values[0]).toEqual([0, 1, 2, 3]);
  });

  it('does not mutate the working buffer it was handed', () => {
    const working = Uint8Array.from({ length: 8 }, (_, i) => i);
    working[2] = 0x99;
    const j: EditJournal = new Map([[2, { original: 2, current: 0x99 }]]);
    originalGrid(working, j, m);
    expect(working[2]).toBe(0x99);
  });
});
