import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { createBinImage, formatPhysical, readValue } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { isUnchangedEdit } from '../src/lib/diffcells.js';
import { editJournal, workingBytes } from '../src/store/stores.js';
import { undo } from '../src/store/undo.js';

const map = (over: Partial<MapDef> = {}): MapDef => ({
  id: 'm1', name: 'M', address: 0x10, rows: 2, cols: 2,
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 0.1, offset: 0, units: '', digits: 1 },
  orientation: 'row-major', provenance: 'manual', ...over,
});

beforeEach(() => {
  a.resetStores();
  a.setBin(createBinImage(new Uint8Array(64).fill(100), 'e.bin'));
});

describe('editCell', () => {
  it('stores the nearest representable raw and reports what it decodes to', () => {
    const r = a.editCell(map(), 0, 0, 14.73);
    expect(r).toMatchObject({ ok: true, clamped: false });
    expect(readValue(get(workingBytes)!, 0x10, map().format)).toBe(147);
    if (r.ok) expect(r.physical).toBeCloseTo(14.7, 6);
  });

  it('clamps out-of-range input and says so', () => {
    const r = a.editCell(map(), 0, 0, 999);
    expect(r).toMatchObject({ ok: true, clamped: true });
    expect(get(workingBytes)![0x10]).toBe(255);
  });

  it('records the edit in the journal', () => {
    a.editCell(map(), 0, 1, 20);
    expect(get(editJournal).get(0x11)).toEqual({ original: 100, current: 200 });
  });

  it('editing back to the original clears the diff entry', () => {
    a.editCell(map(), 0, 0, 20);
    expect(get(editJournal).size).toBe(1);
    a.editCell(map(), 0, 0, 10);
    expect(get(editJournal).size).toBe(0);
  });

  it('refuses a cell whose scaling cannot be inverted', () => {
    const r = a.editCell(map({ scaling: { factor: 0, offset: 0, units: '', digits: 0 } }), 0, 0, 5);
    expect(r).toEqual({ ok: false, reason: 'This map’s scaling factor is 0, so a physical value cannot be converted to a raw one.' });
  });

  it('is ONE undo entry and fully reverts', () => {
    a.editCell(map(), 0, 0, 20);
    expect(get(editJournal).size).toBe(1);
    expect(undo()).toBe(true);
    expect(get(editJournal).size).toBe(0);
    expect(get(workingBytes)![0x10]).toBe(100);
  });
});

/**
 * C1/M9 (final whole-branch review): MapView's commit handler must guard a
 * no-op edit with `isUnchangedEdit(seed, text)` BEFORE ever calling `editCell`
 * — this is the exact call pattern the component uses. Reproduces the
 * measured hazard (factor 0.1, digits 0) at the store level: opening the
 * editor and committing the unedited seed text must leave the journal empty,
 * even though parsing that seed back would land on a different raw byte.
 */
describe('commit-guard pattern (C1): a no-op display round-trip must not rewrite the byte', () => {
  it('leaves the journal empty when the committed text is the unchanged seed', () => {
    const bytes = new Uint8Array(64);
    bytes[0x10] = 2; // raw value 2
    a.setBin(createBinImage(bytes, 'seed.bin'));
    const m = map({ scaling: { factor: 0.1, offset: 0, units: '', digits: 0 } });
    const seed = formatPhysical(2, m.scaling); // rounds away the true value
    // MapView's commitEdit: guard first, only call editCell when the guard says "changed".
    if (!isUnchangedEdit(seed, seed)) a.editCell(m, 0, 0, Number(seed));
    expect(get(editJournal).size).toBe(0);
    expect(get(workingBytes)![0x10]).toBe(2); // byte is untouched
  });

  it('WITHOUT the guard, committing that same seed text would have rewritten the byte — proves the hazard is real', () => {
    const bytes = new Uint8Array(64);
    bytes[0x10] = 2;
    a.setBin(createBinImage(bytes, 'seed2.bin'));
    const m = map({ scaling: { factor: 0.1, offset: 0, units: '', digits: 0 } });
    const seed = formatPhysical(2, m.scaling);
    a.editCell(m, 0, 0, Number(seed)); // the old, unguarded commit path
    expect(get(workingBytes)![0x10]).not.toBe(2);
  });
});
