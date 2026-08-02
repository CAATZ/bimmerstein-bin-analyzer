import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AxisDef, MapDef } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { UNDO_LIMIT, clearUndo, redo, undo, undoState } from '../src/store/undo.js';
import { axisLibrary, maps, potentialMaps, viewParams } from '../src/store/stores.js';

function testBin() {
  return createBinImage(Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff), 'undo.bin');
}

function mapAt(id: string, address: number, provenance: MapDef['provenance']): MapDef {
  return {
    id, name: `M ${id}`, address, rows: 2, cols: 4,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major', provenance,
    ...(provenance === 'auto' ? { confidence: 0.8, detector: 'generic' as const } : {}),
  };
}

const axis: AxisDef = {
  kind: 'referenced', address: 0x800, count: 4,
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 40, offset: 0, units: 'rpm', digits: 0 },
};

beforeEach(() => {
  a.resetStores();
  a.setBin(testBin());
});

describe('undo stack', () => {
  it('starts empty', () => {
    expect(get(undoState)).toEqual({ canUndo: false, canRedo: false, nextUndoLabel: null });
    expect(undo()).toBe(false);
    expect(redo()).toBe(false);
  });

  it('undoes a rename and redoes it', () => {
    a.addImportedMaps([mapAt('m1', 0x100, 'imported')]);
    a.updateMapMeta('m1', { name: 'Dwell' });
    expect(get(maps)[0]!.name).toBe('Dwell');

    expect(undo()).toBe(true);
    expect(get(maps)[0]!.name).toBe('M m1');
    expect(redo()).toBe(true);
    expect(get(maps)[0]!.name).toBe('Dwell');
  });

  it('labels the next undo', () => {
    a.addImportedMaps([mapAt('m1', 0x100, 'imported')]);
    expect(get(undoState).nextUndoLabel).toBe('import maps');
  });

  it('a REJECTED action pushes nothing', () => {
    a.addImportedMaps([mapAt('m1', 0x100, 'imported')]);
    clearUndo();
    const r = a.updateMapMeta('nope', { name: 'x' });
    expect(r.ok).toBe(false);
    expect(get(undoState).canUndo).toBe(false);
  });

  it('a nested transaction pushes exactly one entry', () => {
    a.addImportedMaps([mapAt('m1', 0x100, 'imported'), mapAt('m2', 0x200, 'imported')]);
    const lib = a.addAxisLibEntry('RPM', axis);
    expect(lib.ok).toBe(true);
    if (!lib.ok) return;
    a.setMapAxis('m1', 'x', { ...axis, libId: lib.value.id });
    a.setMapAxis('m2', 'x', { ...axis, libId: lib.value.id });
    clearUndo();

    const { detached } = a.detachAxisLibEntry(lib.value.id); // calls setMapAxis twice
    expect(detached).toBe(2);
    expect(undo()).toBe(true);
    expect(get(maps).filter((m) => m.xAxis?.libId === lib.value.id)).toHaveLength(2);
    expect(get(undoState).canUndo).toBe(false); // exactly one entry was pushed
  });

  it('is bounded and drops the oldest', () => {
    a.addImportedMaps([mapAt('m1', 0x100, 'imported')]);
    clearUndo();
    for (let i = 0; i < UNDO_LIMIT + 10; i++) a.updateMapMeta('m1', { name: `n${i}` });
    let depth = 0;
    while (undo()) depth++;
    expect(depth).toBe(UNDO_LIMIT);
  });

  it('a new action clears the redo branch', () => {
    a.addImportedMaps([mapAt('m1', 0x100, 'imported')]);
    a.updateMapMeta('m1', { name: 'A' });
    expect(undo()).toBe(true);
    expect(get(undoState).canRedo).toBe(true);
    a.updateMapMeta('m1', { name: 'B' });
    expect(get(undoState).canRedo).toBe(false);
  });

  it('loading a new bin clears the stack', () => {
    a.addImportedMaps([mapAt('m1', 0x100, 'imported')]);
    expect(get(undoState).canUndo).toBe(true);
    a.setBin(testBin());
    expect(get(undoState).canUndo).toBe(false);
  });

  it('view changes do not push', () => {
    a.addImportedMaps([mapAt('m1', 0x100, 'imported')]);
    clearUndo();
    a.setViewMode('2d');
    a.adjustColumns(8);
    a.setSelection(0, 8);
    expect(get(undoState).canUndo).toBe(false);
    expect(get(viewParams).viewMode).toBe('2d');
  });

  it('covers promote, remove and the axis library', () => {
    potentialMaps.set([mapAt('p1', 0x300, 'auto')]);
    a.promoteMap('p1');
    expect(undo()).toBe(true);
    expect(get(potentialMaps)).toHaveLength(1);
    expect(get(maps)).toHaveLength(0);

    a.addImportedMaps([mapAt('m1', 0x100, 'imported')]);
    a.removeMap('m1');
    expect(undo()).toBe(true);
    expect(get(maps)).toHaveLength(1);

    a.addAxisLibEntry('RPM', axis);
    expect(get(axisLibrary)).toHaveLength(1);
    expect(undo()).toBe(true);
    expect(get(axisLibrary)).toHaveLength(0);
  });

  it('removeMap for an unknown id pushes nothing', () => {
    a.addImportedMaps([mapAt('m1', 0x100, 'imported')]);
    clearUndo();
    a.removeMap('ghost');
    expect(get(undoState).canUndo).toBe(false);
  });

  it('an import that lands nothing pushes nothing', () => {
    clearUndo();
    const r = a.addImportedMaps([mapAt('oob', 0x99999, 'imported')]);
    expect(r.added).toBe(0);
    expect(get(undoState).canUndo).toBe(false);
  });
});
