import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { MapDef } from '@binanalyzer/core';
import { createBinImage, writeValue } from '@binanalyzer/core';
import { curveSeries, isCurveShaped } from '../src/lib/curvedata.js';
import { bytesForDisplay } from '../src/lib/diffcells.js';
import * as actions from '../src/store/actions.js';
import { editJournal, workingBytes } from '../src/store/stores.js';

const fmt = { width: 1, signed: false, endianness: 'big' } as const;
const mk = (over: Partial<MapDef>): MapDef => ({
  id: 'c', name: 'C', address: 0x10, rows: 4, cols: 1, format: fmt,
  scaling: { factor: 0.5, offset: -10, units: 'deg', digits: 1 },
  orientation: 'row-major', provenance: 'manual', ...over,
});

describe('curveSeries', () => {
  it('decodes physical Y values along the long dimension and X from the bound axis', () => {
    const bytes = new Uint8Array(0x40);
    bytes.set([10, 20, 30, 40], 0x10);      // data
    bytes.set([1, 2, 3, 4], 0x08);          // axis cells
    const m = mk({ yAxis: { kind: 'referenced', address: 0x08, count: 4, format: fmt } });
    const s = curveSeries(bytes, m);
    expect(s.y).toEqual([10 * 0.5 - 10, 20 * 0.5 - 10, 30 * 0.5 - 10, 40 * 0.5 - 10]);
    expect(s.x).toEqual([1, 2, 3, 4]);
    expect(s.xIsIndex).toBe(false);
  });
  it('falls back to index X when no axis is bound, and handles 1×N orientation', () => {
    const bytes = new Uint8Array(0x40);
    bytes.set([5, 6, 7], 0x10);
    const m = mk({ rows: 1, cols: 3 });
    const s = curveSeries(bytes, m);
    expect(s.x).toEqual([0, 1, 2]);
    expect(s.xIsIndex).toBe(true);
    expect(s.y).toHaveLength(3);
  });
  it('never throws on an unreadable axis — falls back to index', () => {
    const bytes = new Uint8Array(0x20);
    const m = mk({ yAxis: { kind: 'referenced', address: 0x1000, count: 4, format: fmt } });
    const s = curveSeries(bytes, m);
    expect(s.xIsIndex).toBe(true);
  });

  it.each(['row-major', 'col-major'] as const)('keeps curve values, axes and original display consistent through edit/undo in %s storage', (orientation) => {
    for (const horizontal of [false, true]) {
      actions.resetStores();
      const format = { width: 2, signed: true, endianness: 'little' } as const;
      const bytes = new Uint8Array(64);
      [-200, 300, 500, 700].forEach((v, i) => writeValue(bytes, 16 + i * 2, format, v));
      [10, 20, 30, 40].forEach((v, i) => writeValue(bytes, 4 + i * 2, format, v));
      const axis = { kind: 'referenced', address: 4, count: 4, format } as const;
      const m = mk({ format, orientation, rows: horizontal ? 1 : 4, cols: horizontal ? 4 : 1,
        ...(horizontal ? { xAxis: axis } : { yAxis: axis }) });
      actions.setBin(createBinImage(bytes, 'curve.bin'));
      const series = (original = false) => curveSeries(bytesForDisplay(get(workingBytes)!, original, get(editJournal)), m);
      const initial = series();
      expect(actions.editCell(m, horizontal ? 0 : 1, horizontal ? 1 : 0, -20).ok).toBe(true);
      expect(series().y).toEqual([-110, -20, 240, 340]);
      expect([...get(editJournal).keys()].sort((a, b) => a - b)).toEqual([18, 19]);
      expect(actions.editAxisValue(m, horizontal ? 'x' : 'y', 1, 25).ok).toBe(true);
      expect(series().x).toEqual([10, 25, 30, 40]);
      expect(series(true)).toEqual(initial);
      expect(actions.undo()).toBe(true);
      expect(series().x).toEqual(initial.x);
      expect(actions.undo()).toBe(true);
      expect(series()).toEqual(initial);
      expect(actions.redo()).toBe(true);
      expect(series().y[1]).toBe(-20);
    }
    actions.resetStores();
  });
});

describe('isCurveShaped (re-exported from @binanalyzer/formats — single source of truth)', () => {
  it('is true for exactly one of rows/cols === 1, false for scalars and grids', () => {
    expect(isCurveShaped(mk({ rows: 6, cols: 1 }))).toBe(true);
    expect(isCurveShaped(mk({ rows: 1, cols: 6 }))).toBe(true);
    expect(isCurveShaped(mk({ rows: 4, cols: 4 }))).toBe(false);
    expect(isCurveShaped(mk({ rows: 1, cols: 1 }))).toBe(false);
  });
});
