import { get } from 'svelte/store';
import { beforeEach, expect, it } from 'vitest';
import { createBinImage, validateMapDef, type MapDef } from '@binanalyzer/core';
import * as actions from '../src/store/actions.js';
import { cellRange, editJournal, maps, transposeMaps, workingBytes } from '../src/store/stores.js';
import { axisLabels, gridFromMap, sourceAxis, sourceCell } from '../src/lib/griddata.js';

beforeEach(() => {
  actions.resetStores();
  actions.setBin(createBinImage(Uint8Array.from({ length: 64 }, (_, i) => i), 'transpose.bin'));
});

it.each([false, true])('aligns column-major headers and axis edits with transpose=%s', (transposed) => {
  const map: MapDef = {
    id: 'column', name: 'Column', address: 8, rows: 2, cols: 3, orientation: 'col-major', provenance: 'manual',
    format: { width: 2, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    xAxis: { kind: 'referenced', address: 32, count: 2, format: { width: 1, signed: false, endianness: 'little' } },
    yAxis: { kind: 'referenced', address: 40, count: 3, format: { width: 1, signed: false, endianness: 'little' } },
  };
  const before = get(workingBytes)!.slice();
  expect(validateMapDef(map, before.length).ok).toBe(true);
  maps.set([map]);
  const grid = gridFromMap(before, map, transposed);
  const x = sourceAxis('x', transposed, map.orientation);
  const y = sourceAxis('y', transposed, map.orientation);
  expect(axisLabels(before, x === 'x' ? map.xAxis : map.yAxis, grid.cols)).toHaveLength(grid.cols);
  expect(axisLabels(before, y === 'x' ? map.xAxis : map.yAxis, grid.rows)).toHaveLength(grid.rows);
  expect(actions.editAxisValue(map, x, 1, 45).ok).toBe(true);
  expect([...get(editJournal).keys()]).toEqual([transposed ? 33 : 41]);
  actions.undo();
  expect(get(workingBytes)).toEqual(before);
  const cell = sourceCell(transposed ? 2 : 1, transposed ? 1 : 2, transposed);
  expect(actions.cellOffset(map, cell.row, cell.col)).toBe(18);
  expect(actions.editCell(map, cell.row, cell.col, 4000).ok).toBe(true);
  expect([...get(editJournal).keys()].sort((a, b) => a - b)).toEqual([18, 19]);
  actions.undo();
  expect(get(workingBytes)).toEqual(before);
});

it('keeps selections, edits, undo and axis edits on their original bytes after swapping the display', () => {
  const map: MapDef = {
    id: 'm', name: 'M', address: 8, rows: 2, cols: 3, orientation: 'row-major', provenance: 'manual',
    format: { width: 2, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    xAxis: { kind: 'referenced', address: 32, count: 3, format: { width: 1, signed: false, endianness: 'little' } },
    yAxis: { kind: 'referenced', address: 40, count: 2, format: { width: 1, signed: false, endianness: 'little' } },
  };
  maps.set([map]);
  const before = get(workingBytes)!.slice();
  actions.setCellRange(map.id, 0, 1, 1, 2);
  const range = get(cellRange);
  actions.toggleMapTranspose();
  expect(get(transposeMaps)).toBe(true);
  expect(get(maps)).toEqual([map]);
  expect(get(cellRange)).toEqual(range);
  expect(get(workingBytes)).toEqual(before);
  expect(get(editJournal).size).toBe(0);

  const cell = sourceCell(2, 1, get(transposeMaps));
  expect(actions.cellOffset(map, cell.row, cell.col)).toBe(18);
  expect(actions.editCell(map, cell.row, cell.col, 4000).ok).toBe(true);
  expect(gridFromMap(get(workingBytes)!, map, true).values[2]![1]).toBe(4000);
  expect([...get(editJournal).keys()].sort((a, b) => a - b)).toEqual([18, 19]);
  actions.undo();
  expect(get(workingBytes)).toEqual(before);

  const horizontal = sourceAxis('x', get(transposeMaps));
  expect(actions.editAxisValue(map, horizontal, 1, 45).ok).toBe(true);
  expect([...get(editJournal).keys()]).toEqual([41]);
  actions.undo();
  expect(get(workingBytes)).toEqual(before);
  actions.setBin(createBinImage(before, 'new.bin'));
  expect(get(transposeMaps)).toBe(false);
});
