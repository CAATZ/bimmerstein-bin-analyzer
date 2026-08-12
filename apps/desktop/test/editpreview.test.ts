import { describe, expect, it } from 'vitest';
import type { AxisDef, MapDef } from '@binanalyzer/core';
import {
  initialChecked, isEditRow, nonMonotonicAxes, previewEdits, type PreviewInput,
} from '../src/lib/editpreview.js';

const u8 = { width: 1, signed: false, endianness: 'little' } as const;
const ident = { factor: 1, offset: 0, units: '', digits: 0 };

/** Ascending breakpoints 10, 20, 30, 40 at 0x30. */
const refAxis: AxisDef = { kind: 'referenced', address: 0x30, count: 4, format: u8, scaling: ident };

const map = (over: Partial<MapDef> = {}): MapDef => ({
  id: 'm1', name: 'Fuel Main', address: 0x10, rows: 2, cols: 2, format: u8,
  scaling: { factor: 0.1, offset: 0, units: 'ms', digits: 1 },
  orientation: 'row-major', provenance: 'manual', ...over,
});

const buffer = (): Uint8Array => {
  const b = new Uint8Array(64).fill(100);
  b.set([10, 20, 30, 40], 0x30);
  return b;
};

const cell = (over: Partial<PreviewInput> = {}): PreviewInput => ({
  id: 'e1', kind: 'cell', mapId: 'm1', row: 0, col: 0, value: 101, raw: true, expectedRaw: 100, ...over,
});

describe('previewEdits', () => {
  it('reports raw and physical before/after, grouped by map', () => {
    const groups = previewEdits({ rows: [cell()], maps: [map()], potentials: [], working: buffer() });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.mapName).toBe('Fuel Main');
    const row = groups[0]!.rows[0]!;
    expect(row.beforeRaw).toBe(100);
    expect(row.afterRaw).toBe(101);
    expect(row.beforePhysical).toBe('10.0');
    expect(row.afterPhysical).toBe('10.1');
    expect(row.stale).toBe(false);
    expect(row.noChange).toBe(false);
  });

  it('flags a row whose byte moved as stale', () => {
    const groups = previewEdits({
      rows: [cell({ expectedRaw: 55 })], maps: [map()], potentials: [], working: buffer(),
    });
    expect(groups[0]!.rows[0]!.stale).toBe(true);
  });

  it('flags a write that quantises onto the byte already there', () => {
    const groups = previewEdits({
      rows: [cell({ value: 100 })], maps: [map()], potentials: [], working: buffer(),
    });
    expect(groups[0]!.rows[0]!.noChange).toBe(true);
  });

  it('flags clamping instead of wrapping', () => {
    const groups = previewEdits({
      rows: [cell({ value: 1e9 })], maps: [map()], potentials: [], working: buffer(),
    });
    expect(groups[0]!.rows[0]!.clamped).toBe(true);
    expect(groups[0]!.rows[0]!.afterRaw).toBe(255);
  });

  it('NEVER mutates the buffer it previews', () => {
    const working = buffer();
    const copy = working.slice();
    previewEdits({ rows: [cell({ value: 42 })], maps: [map()], potentials: [], working });
    expect([...working]).toEqual([...copy]);
  });

  it('carries an error for a row whose target cannot be resolved', () => {
    const groups = previewEdits({
      rows: [cell({ mapId: 'nope' })], maps: [map()], potentials: [], working: buffer(),
    });
    expect(groups[0]!.rows[0]!.error).toBeDefined();
  });

  it('names the fan-out on a shared axis row', () => {
    const mine = map({ rows: 1, cols: 4, xAxis: refAxis });
    const other = map({ id: 'm2', name: 'Ignition Main', address: 0x20, rows: 1, cols: 4, xAxis: refAxis });
    const groups = previewEdits({
      rows: [{ id: 'a1', kind: 'axis', mapId: 'm1', axis: 'x', index: 1, value: 25, raw: true, expectedRaw: 20 }],
      maps: [mine, other], potentials: [], working: buffer(),
    });
    expect(groups[0]!.rows[0]!.shared).toEqual(['Ignition Main']);
  });

  it('finds a map among the potentials too', () => {
    const groups = previewEdits({ rows: [cell()], maps: [], potentials: [map()], working: buffer() });
    expect(groups[0]!.rows[0]!.error).toBeUndefined();
  });
});

describe('nonMonotonicAxes', () => {
  // Accepting a SUBSET of axis rows is a different axis from accepting all of
  // them, so a warning computed once at submit time would describe an axis
  // nobody is going to get.
  const rows: PreviewInput[] = [
    { id: 'a1', kind: 'axis', mapId: 'm1', axis: 'x', index: 0, value: 99, raw: true, expectedRaw: 10 },
    { id: 'a2', kind: 'axis', mapId: 'm1', axis: 'x', index: 3, value: 200, raw: true, expectedRaw: 40 },
  ];
  const maps = [map({ rows: 1, cols: 4, xAxis: refAxis })];

  it('reports nothing when nothing is checked', () => {
    expect(nonMonotonicAxes({ rows, checkedIds: new Set(), maps, potentials: [], working: buffer() })).toEqual([]);
  });

  it('reports the axis when the checked row breaks the order', () => {
    // a1 alone: 99, 20, 30, 40 — no longer ascending.
    const out = nonMonotonicAxes({ rows, checkedIds: new Set(['a1']), maps, potentials: [], working: buffer() });
    expect(out).toEqual(['Fuel Main X axis']);
  });

  it('reports nothing when the checked row keeps the order', () => {
    // a2 alone: 10, 20, 30, 200 — still ascending.
    const out = nonMonotonicAxes({ rows, checkedIds: new Set(['a2']), maps, potentials: [], working: buffer() });
    expect(out).toEqual([]);
  });

  it('does not mutate the live buffer while drafting', () => {
    const working = buffer();
    const copy = working.slice();
    nonMonotonicAxes({ rows, checkedIds: new Set(['a1', 'a2']), maps, potentials: [], working });
    expect([...working]).toEqual([...copy]);
  });
});

describe('panel helpers', () => {
  it('isEditRow recognises the two edit kinds and nothing else', () => {
    expect(isEditRow({ id: 'a', kind: 'cell' })).toBe(true);
    expect(isEditRow({ id: 'a', kind: 'axis' })).toBe(true);
    expect(isEditRow({ id: 'a', mapId: 'm', name: 'x' })).toBe(false);
  });

  it('starts every row checked EXCEPT stale ones', () => {
    // Everything checked is right on a 306-row import; a stale row is one whose
    // premise the user can SEE is no longer true, so including it should take a
    // deliberate click (Part C §5).
    const groups = previewEdits({
      rows: [cell(), cell({ id: 'e2', col: 1, expectedRaw: 55 })],
      maps: [map()], potentials: [], working: buffer(),
    });
    expect(initialChecked(groups)).toEqual({ e1: true, e2: false });
  });

  it('leaves an unresolvable row unchecked', () => {
    const groups = previewEdits({
      rows: [cell({ mapId: 'nope' })], maps: [map()], potentials: [], working: buffer(),
    });
    expect(initialChecked(groups)).toEqual({ e1: false });
  });
});
