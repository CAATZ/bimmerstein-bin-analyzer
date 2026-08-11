import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { editJournal, workingBytes } from '../src/store/stores.js';
import { undo } from '../src/store/undo.js';

const map = (over: Partial<MapDef> = {}): MapDef => ({
  id: 'm1', name: 'M', address: 0, rows: 1, cols: 4,
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major', provenance: 'manual', ...over,
});
const cells = [0, 1, 2, 3].map((col) => ({ row: 0, col }));

beforeEach(() => {
  a.resetStores();
  a.setBin(createBinImage(new Uint8Array(16).fill(100), 'r.bin'));
});

describe('applyRegionDelta', () => {
  it('steps every cell by one raw LSB', () => {
    const r = a.applyRegionDelta(map(), cells, { kind: 'step', steps: 1 });
    expect(r).toEqual({ moved: 4, clamped: 0 });
    expect([...get(workingBytes)!.slice(0, 4)]).toEqual([101, 101, 101, 101]);
  });

  it('steps down, and a negative step is symmetric', () => {
    a.applyRegionDelta(map(), cells, { kind: 'step', steps: -2 });
    expect([...get(workingBytes)!.slice(0, 4)]).toEqual([98, 98, 98, 98]);
  });

  it('reports how many cells a percentage ACTUALLY moved', () => {
    // +0.4% of 100 = 100.4 → rounds back to 100 on a factor-1 cell: nothing moved.
    const r = a.applyRegionDelta(map(), cells, { kind: 'percent', percent: 0.4 });
    expect(r.moved).toBe(0);
    expect(get(editJournal).size).toBe(0);
  });

  it('sets every cell to one physical value', () => {
    const r = a.applyRegionDelta(map(), cells, { kind: 'set', physical: 7 });
    expect(r.moved).toBe(4);
    expect([...get(workingBytes)!.slice(0, 4)]).toEqual([7, 7, 7, 7]);
  });

  it('counts clamped cells separately from moved ones', () => {
    const r = a.applyRegionDelta(map(), cells, { kind: 'set', physical: 999 });
    expect(r.clamped).toBe(4);
    expect([...get(workingBytes)!.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  });

  it('is ONE undo entry for the whole region', () => {
    a.applyRegionDelta(map(), cells, { kind: 'step', steps: 5 });
    undo();
    expect([...get(workingBytes)!.slice(0, 4)]).toEqual([100, 100, 100, 100]);
    expect(get(editJournal).size).toBe(0);
  });
});
