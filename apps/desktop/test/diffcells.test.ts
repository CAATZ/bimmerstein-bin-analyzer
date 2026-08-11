import { describe, expect, it } from 'vitest';
import type { EditJournal, MapDef, Scaling } from '@binanalyzer/core';
import { formatPhysical, quantise } from '@binanalyzer/core';
import { isCellChanged, isUnchangedEdit, originalBytes, originalGrid } from '../src/lib/diffcells.js';

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

describe('originalBytes', () => {
  it('rebuilds the file-as-opened bytes from working + journal', () => {
    const working = Uint8Array.from({ length: 8 }, (_, i) => i);
    working[2] = 0x99; // an edit
    const j: EditJournal = new Map([[2, { original: 2, current: 0x99 }]]);
    expect([...originalBytes(working, j)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('does not mutate the working buffer it was handed', () => {
    const working = Uint8Array.from({ length: 4 }, (_, i) => i);
    working[1] = 0xaa;
    const j: EditJournal = new Map([[1, { original: 1, current: 0xaa }]]);
    originalBytes(working, j);
    expect(working[1]).toBe(0xaa);
  });

  it('originalGrid is exactly gridFromMap over originalBytes — one source of truth', () => {
    const m: MapDef = {
      id: 'm2', name: 'm2', address: 0, rows: 1, cols: 4,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'manual',
    };
    const working = Uint8Array.from({ length: 8 }, (_, i) => i);
    working[2] = 0x99;
    const j: EditJournal = new Map([[2, { original: 2, current: 0x99 }]]);
    expect(originalGrid(working, j, m).values).toEqual([[...originalBytes(working, j).subarray(0, 4)]]);
  });
});

/**
 * C1 (critical, final whole-branch review): `beginEdit` seeds the input with
 * `formatPhysical(value, scaling)`, which ROUNDS to `scaling.digits`. Comparing
 * `Number(committedText)` to the original raw/physical value is NOT a safe
 * no-op guard — the display text can round-trip to a DIFFERENT raw byte than
 * the one it was seeded from. Only exact TEXT identity between the seed and
 * the committed text is safe.
 */
describe('isUnchangedEdit (C1 — a no-op display round-trip must not rewrite the byte)', () => {
  it('is true when the committed text is byte-identical to the seed', () => {
    expect(isUnchangedEdit('0.02', '0.02')).toBe(true);
  });

  it('is false for any different text, even one that PARSES to the same number', () => {
    expect(isUnchangedEdit('0.02', '0.020')).toBe(false);
    expect(isUnchangedEdit('2', '2.0')).toBe(false);
  });

  it('demonstrates the hazard this guards against: a coarse-digits seed does not round-trip to its own raw value', () => {
    // factor 0.1, digits 0 on a width-1 cell — exactly the review's measured case.
    const scaling: Scaling = { factor: 0.1, offset: 0, units: '', digits: 0 };
    const format = { width: 1, signed: false, endianness: 'little' } as const;
    const raw = 2;
    const seed = formatPhysical(raw, scaling);
    // Parsing the seed back does NOT reproduce raw 2 — comparing NUMBERS is unsafe.
    expect(quantise(Number(seed), scaling, format).stored).not.toBe(raw);
    // Text identity between the seed and itself must still say "unchanged".
    expect(isUnchangedEdit(seed, seed)).toBe(true);
  });
});
