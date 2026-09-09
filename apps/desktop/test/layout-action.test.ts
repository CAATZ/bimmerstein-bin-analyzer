import { beforeEach, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createBinImage, type MapDef } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { cellRange, editJournal, maps, selection, workingBytes } from '../src/store/stores.js';
import { undoState } from '../src/store/undo.js';

const u8 = { width: 1, signed: false, endianness: 'little' } as const;
const original: MapDef = { id: 'm', name: 'Named map', category: 'Fuel', notes: 'Keep',
  address: 128, rows: 4, cols: 4, format: u8, orientation: 'row-major', provenance: 'imported',
  scaling: { factor: 2, offset: 1, units: 'unit', digits: 1 },
  xAxis: { kind: 'index', count: 4 }, yAxis: { kind: 'literal', count: 4, values: [1,2,3,4] } };

beforeEach(() => { a.resetStores(); a.setBin(createBinImage(new Uint8Array(512), 'b.bin')); maps.set([original]); });

it('changes layout and selection in one undo step, preserving edited bytes and project metadata', () => {
  a.selectMap(original);
  a.editCell(original, 0, 0, 9);
  const before = get(workingBytes)!.slice(), journal = new Map(get(editJournal));
  const target = { address: 127, rows: 4, cols: 2, format: { ...u8, width: 2 as const } };
  const result = a.setMapLayout('m', target);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual({ ...original, ...target, xAxis: undefined });
  expect('xAxis' in result.value).toBe(false);
  expect(get(selection)).toEqual({ mapId: 'm', start: 127, end: 143, cols: 2 });
  expect(get(cellRange)).toBeNull();
  expect(get(workingBytes)).toEqual(before);
  expect(get(editJournal)).toEqual(journal);
  const project = a.projectSnapshot();
  expect(project.ok && project.value.maps[0]).toEqual(result.value);
  a.undo();
  expect(get(maps)).toEqual([original]);
  expect(get(selection)?.start).toBe(128);
  expect(get(workingBytes)).toEqual(before);
  a.redo();
  expect(get(maps)[0]).toEqual(result.value);
});

it('rejects invalid changes without an undo entry and leaves identical layouts alone', () => {
  expect(a.setMapLayout('missing', original).ok).toBe(false);
  expect(a.setMapLayout('m', { ...original, address: 510 }).ok).toBe(false);
  expect(a.setMapLayout('m', { ...original, cols: 1 }).ok).toBe(false);
  expect(a.setMapLayout('m', original).ok).toBe(true);
  expect(a.setMapLayout('m', { ...original, format: { endianness: 'little', signed: false, width: 1 } }).ok).toBe(true);
  expect(get(undoState).canUndo).toBe(false);
  expect(get(maps)).toEqual([original]);
});
