import { beforeEach, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createBinImage, type MapDef } from '@binanalyzer/core';
import { DEFAULT_MAP_FILTER, detectionDescription, filterMaps } from '../src/lib/mapfilter.js';
import * as actions from '../src/store/actions.js';
import { mapFilter, potentialMaps, selection } from '../src/store/stores.js';

const maps: MapDef[] = [
  { id: 'fuel', name: 'Fuel Base', address: 0x369e, rows: 20, cols: 16, orientation: 'row-major', provenance: 'auto', confidence: 0.9, detector: 'structural', format: { width: 1, signed: false, endianness: 'little' }, scaling: { factor: 1, offset: 0, units: '', digits: 0 } },
  { id: 'curve', name: 'Fuel Curve', address: 0x4188, rows: 8, cols: 1, orientation: 'row-major', provenance: 'auto', confidence: 0.95, detector: 'family', format: { width: 1, signed: false, endianness: 'little' }, scaling: { factor: 1, offset: 0, units: '', digits: 0 } },
];
beforeEach(() => actions.resetStores());

it('combines name, hexadecimal address and dimensions with shape/method filters without reordering', () => {
  expect(filterMaps(maps, DEFAULT_MAP_FILTER)).toEqual(maps);
  for (const query of [' fuel base ', '0x369E', '369e', '20x16', '20 × 16']) {
    expect(filterMaps(maps, { ...DEFAULT_MAP_FILTER, query })).toEqual([maps[0]]);
  }
  expect(filterMaps(maps, { query: 'fuel', shape: 'curve', detector: 'family' })).toEqual([maps[1]]);
  expect(filterMaps(maps, { query: '', shape: 'grid', detector: 'family' })).toEqual([]);
  expect(filterMaps(maps, { ...DEFAULT_MAP_FILTER, query: 'unknown' })).toEqual([]);
});

it('keeps navigation within visible candidates and resets filters for a new BIN', () => {
  potentialMaps.set(maps);
  actions.selectMap(maps[0]!);
  actions.setMapFilter({ ...DEFAULT_MAP_FILTER, shape: 'curve' });
  expect(get(selection)?.mapId).toBe('fuel');
  actions.stepPotential(1);
  expect(get(selection)?.mapId).toBe('curve');
  actions.stepPotential(-1);
  expect(get(selection)?.mapId).toBe('curve');
  expect(get(potentialMaps)).toEqual(maps);
  actions.setBin(createBinImage(new Uint8Array(64), 'new.bin'));
  expect(get(mapFilter)).toEqual(DEFAULT_MAP_FILTER);
});

it('explains structural score limits and does not claim family candidates are code-proven', () => {
  expect(detectionDescription(maps[0]!)).toContain('fixed score');
  expect(detectionDescription(maps[0]!)).toContain('verify');
  expect(detectionDescription(maps[1]!)).toContain('structural fallbacks');
  expect(detectionDescription(maps[1]!)).not.toContain('code-proven');
});
