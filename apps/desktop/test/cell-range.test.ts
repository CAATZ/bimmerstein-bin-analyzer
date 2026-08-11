import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { cellRange, workingBytes } from '../src/store/stores.js';

/**
 * Amendment (owner decision, 2026-08-09): a real cell range, because `+`/`-`
 * previously stepped the ENTIRE map — no task ever built the `selectedCells`
 * set Task 7 assumed.
 */

const map = (over: Partial<MapDef> = {}): MapDef => ({
  id: 'm1', name: 'M', address: 0, rows: 3, cols: 3,
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major', provenance: 'manual', ...over,
});

beforeEach(() => {
  a.resetStores();
  a.setBin(createBinImage(new Uint8Array(16).fill(100), 'r.bin'));
});

describe('setCellRange / clearCellRange', () => {
  it('a plain click sets a 1x1 range', () => {
    a.setCellRange('m1', 1, 1, 1, 1);
    expect(get(cellRange)).toEqual({ mapId: 'm1', r0: 1, c0: 1, r1: 1, c1: 1 });
  });

  it('clearCellRange resets to null — what MapView relies on when the shown map changes', () => {
    a.setCellRange('m1', 0, 0, 1, 1);
    a.clearCellRange();
    expect(get(cellRange)).toBeNull();
  });

  it('starts null before anything is selected', () => {
    expect(get(cellRange)).toBeNull();
  });
});

describe('cellsInRange corner normalisation', () => {
  const expected = [
    { row: 0, col: 0 }, { row: 0, col: 1 },
    { row: 1, col: 0 }, { row: 1, col: 1 },
  ];

  it('down-and-right drag', () => {
    expect(a.cellsInRange({ mapId: 'm1', r0: 0, c0: 0, r1: 1, c1: 1 })).toEqual(expected);
  });

  it('up-and-left drag yields the SAME set', () => {
    expect(a.cellsInRange({ mapId: 'm1', r0: 1, c0: 1, r1: 0, c1: 0 })).toEqual(expected);
  });

  it('up-and-right drag yields the SAME set', () => {
    expect(a.cellsInRange({ mapId: 'm1', r0: 1, c0: 0, r1: 0, c1: 1 })).toEqual(expected);
  });

  it('down-and-left drag yields the SAME set', () => {
    expect(a.cellsInRange({ mapId: 'm1', r0: 0, c0: 1, r1: 1, c1: 0 })).toEqual(expected);
  });
});

describe('cellsInRange', () => {
  it('a 1x1 click range yields exactly one cell', () => {
    expect(a.cellsInRange({ mapId: 'm1', r0: 2, c0: 1, r1: 2, c1: 1 })).toEqual([{ row: 2, col: 1 }]);
  });

  it('yields exactly the covered cells for a multi-row rectangle, in row-major order', () => {
    expect(a.cellsInRange({ mapId: 'm1', r0: 0, c0: 0, r1: 2, c1: 1 })).toEqual([
      { row: 0, col: 0 }, { row: 0, col: 1 },
      { row: 1, col: 0 }, { row: 1, col: 1 },
      { row: 2, col: 0 }, { row: 2, col: 1 },
    ]);
  });

  it('returns empty for a null range', () => {
    expect(a.cellsInRange(null)).toEqual([]);
  });
});

describe('applyRegionDelta over cellsInRange', () => {
  it('touches ONLY the ranged cells, leaving a NEIGHBOURING cell untouched', () => {
    // map is 3x3 row-major, address 0, width 1: (0,0)->0 (0,1)->1 (0,2)->2 (1,0)->3 ...
    const m = map();
    const cells = a.cellsInRange({ mapId: m.id, r0: 0, c0: 0, r1: 0, c1: 0 }); // single cell (0,0)
    const r = a.applyRegionDelta(m, cells, { kind: 'step', steps: 5 });
    expect(r.moved).toBe(1);
    const wb = get(workingBytes)!;
    expect(wb[0]).toBe(105); // the ranged cell moved
    expect(wb[1]).toBe(100); // neighbouring cell (0,1) — untouched
    expect(wb[3]).toBe(100); // neighbouring cell (1,0) — untouched
  });

  it('a multi-cell range touches only its rectangle, not the rest of the map', () => {
    const m = map();
    const cells = a.cellsInRange({ mapId: m.id, r0: 0, c0: 0, r1: 1, c1: 1 }); // top-left 2x2
    const r = a.applyRegionDelta(m, cells, { kind: 'step', steps: 3 });
    expect(r.moved).toBe(4);
    const wb = get(workingBytes)!;
    expect([...wb.slice(0, 2)]).toEqual([103, 103]); // row 0, cols 0-1
    expect(wb[2]).toBe(100); // row 0, col 2 — outside the range, untouched
    expect([...wb.slice(3, 5)]).toEqual([103, 103]); // row 1, cols 0-1
    expect(wb[5]).toBe(100); // row 1, col 2 — outside the range, untouched
    expect([...wb.slice(6, 9)]).toEqual([100, 100, 100]); // row 2 entirely untouched
  });
});

describe('cellsForDelta', () => {
  it('a range for the SHOWN map yields exactly that range\'s cells', () => {
    const m = map({ id: 'm1' });
    const range = { mapId: 'm1', r0: 0, c0: 0, r1: 1, c1: 1 };
    expect(a.cellsForDelta(m, range)).toEqual(a.cellsInRange(range));
  });

  // I1 (final whole-branch review, approved behaviour change): a stray '+'/'-'
  // must never rewrite an entire map. No usable range now means NO target —
  // not "every cell" — so both a foreign-map range and no range at all yield
  // an empty cell list, and the caller (App.svelte) tells the user to select
  // a range first instead of calling applyRegionDelta.
  it('a range whose mapId is a DIFFERENT map is ignored — no cells, not the whole map', () => {
    const m = map({ id: 'm1', rows: 3, cols: 3 });
    const range = { mapId: 'm2', r0: 0, c0: 0, r1: 0, c1: 0 };
    expect(a.cellsForDelta(m, range)).toEqual([]);
  });

  it('a null range yields no cells — no target, not the whole map', () => {
    const m = map({ id: 'm1', rows: 2, cols: 3 });
    expect(a.cellsForDelta(m, null)).toEqual([]);
  });
});
