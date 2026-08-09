import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapDef, Project } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import {
  bin, binPath, checksumReport, maps, modalOpen, potentialMaps, regions, scanStatus, scrollRequest, selection, toasts,
  viewParams,
} from '../src/store/stores.js';

/** 256-byte bin: bytes[i] = i & 0xff — deterministic values for range math. */
function testBin() {
  return createBinImage(Uint8Array.from({ length: 256 }, (_, i) => i & 0xff), 'test.bin');
}

function potential(id: string, address: number, rows = 2, cols = 4, confidence = 0.9): MapDef {
  return {
    id, name: `P ${id}`, address, rows, cols,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major', provenance: 'auto', confidence,
  };
}

beforeEach(() => {
  a.resetStores();
  a.setBin(testBin());
});

describe('setBin / resetStores', () => {
  it('setBin resets maps, potentials, regions, selection, scan status and view params', () => {
    maps.set([{ ...potential('m', 0), provenance: 'manual' } as MapDef]);
    a.setSelection(0, 8);
    a.setBin(testBin());
    expect(get(maps)).toEqual([]);
    expect(get(potentialMaps)).toEqual([]);
    expect(get(regions)).toEqual([]);
    expect(get(selection)).toBeNull();
    expect(get(scanStatus)).toEqual({ state: 'idle' });
    expect(get(viewParams).columns).toBe(16);
    expect(get(viewParams).format).toEqual({ width: 1, signed: false, endianness: 'little' });
  });
});

describe('scan status transitions', () => {
  it('running → progress → result lands regions + ranked potentials', () => {
    a.setScanRunning();
    expect(get(scanStatus)).toEqual({ state: 'running', stage: 'regions', fraction: 0 });
    a.setScanProgress('tables', 0.45);
    expect(get(scanStatus)).toEqual({ state: 'running', stage: 'tables', fraction: 0.45 });
    const pots = [potential('auto-1', 0x10), potential('auto-2', 0x40, 2, 4, 0.99)];
    a.applyScanResult({ regions: [{ start: 0, end: 256, kind: 'data' }], potentialMaps: pots });
    expect(get(scanStatus)).toEqual({ state: 'done' });
    expect(get(regions)).toHaveLength(1);
    // emission order preserved — NEVER re-sorted by confidence
    expect(get(potentialMaps).map((m) => m.id)).toEqual(['auto-1', 'auto-2']);
  });

  it('error surfaces a toast and keeps the app model intact', () => {
    a.setScanError('boom');
    expect(get(scanStatus)).toEqual({ state: 'error', message: 'boom' });
    expect(get(toasts).some((t) => t.kind === 'error' && t.text.includes('boom'))).toBe(true);
    expect(get(bin)).not.toBeNull();
  });
});

describe('selection + selectMap', () => {
  it('setSelection stores a range and drops empty ranges', () => {
    a.setSelection(4, 12, 4);
    expect(get(selection)).toEqual({ start: 4, end: 12, cols: 4 });
    a.setSelection(5, 5);
    expect(get(selection)).toBeNull();
  });

  it('selectMap selects the byte span, remembers cols + mapId, and requests a scroll', () => {
    const before = get(scrollRequest);
    const m = potential('auto-9', 0x20, 3, 4);
    a.selectMap(m);
    expect(get(selection)).toEqual({ start: 0x20, end: 0x20 + 12, cols: 4, mapId: 'auto-9' });
    const req = get(scrollRequest);
    expect(req?.offset).toBe(0x20);
    expect(req?.seq).not.toBe(before?.seq);
  });
});

describe('promoteMap', () => {
  it('moves the map to confirmed, strips confidence, sets provenance manual', () => {
    potentialMaps.set([potential('auto-1', 0x10), potential('auto-2', 0x40)]);
    expect(a.promoteMap('auto-2')).toBe(true);
    const confirmed = get(maps);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.id).toBe('auto-2');
    expect(confirmed[0]!.provenance).toBe('manual');
    expect('confidence' in confirmed[0]!).toBe(false);
    expect(get(potentialMaps).map((m) => m.id)).toEqual(['auto-1']);
  });

  it('strips detector too — it is valid only on auto maps (core validateMapDef)', () => {
    potentialMaps.set([{ ...potential('auto-3', 0x80), detector: 'family' } as MapDef]);
    expect(a.promoteMap('auto-3')).toBe(true);
    const confirmed = get(maps);
    expect('detector' in confirmed[0]!).toBe(false);
    expect(confirmed[0]!.provenance).toBe('manual');
  });

  it('returns false for unknown ids and touches nothing', () => {
    potentialMaps.set([potential('auto-1', 0x10)]);
    expect(a.promoteMap('nope')).toBe(false);
    expect(get(potentialMaps)).toHaveLength(1);
    expect(get(maps)).toHaveLength(0);
  });
});

describe('addMapFromSelection / confirmSelection (K)', () => {
  it('creates a manual map from the snapped selection', () => {
    a.setSelection(0x10, 0x10 + 24, 8);
    const r = a.addMapFromSelection();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({ address: 0x10, rows: 3, cols: 8, provenance: 'manual' });
      expect(r.value.confidence).toBeUndefined();
    }
    expect(get(maps)).toHaveLength(1);
    expect(get(selection)?.mapId).toBe(r.ok ? r.value.id : '');
  });

  it('falls back to viewParams.columns when the selection has no cols', () => {
    a.setSelection(0, 32);
    const r = a.addMapFromSelection();
    expect(r.ok && r.value.cols === 16 && r.value.rows === 2).toBe(true);
  });

  it('rejects selections smaller than one row and out-of-range maps', () => {
    a.setSelection(0, 4); // 4 bytes < 16 cols
    expect(a.addMapFromSelection().ok).toBe(false);
    a.setSelection(250, 256, 8); // 6 bytes → rows 0
    expect(a.addMapFromSelection().ok).toBe(false);
  });

  it('K promotes when the selection IS a potential map, else creates', () => {
    potentialMaps.set([potential('auto-1', 0x10)]);
    a.selectMap(get(potentialMaps)[0]!);
    a.confirmSelection();
    expect(get(maps).map((m) => m.id)).toEqual(['auto-1']);
    a.setSelection(0x40, 0x60, 8);
    a.confirmSelection();
    expect(get(maps)).toHaveLength(2);
  });

  it('K on an already-confirmed map is a no-op (no duplicate at the same address)', () => {
    potentialMaps.set([potential('auto-1', 0x10)]);
    a.selectMap(get(potentialMaps)[0]!);
    a.confirmSelection(); // promotes; selection.mapId now points into maps
    a.confirmSelection(); // must NOT create a second map
    expect(get(maps)).toHaveLength(1);
  });
});

describe('map maintenance', () => {
  it('removeMap drops the map and clears a selection pointing at it', () => {
    potentialMaps.set([potential('auto-1', 0x10)]);
    a.promoteMap('auto-1');
    a.selectMap(get(maps)[0]!);
    a.removeMap('auto-1');
    expect(get(maps)).toHaveLength(0);
    expect(get(selection)).toBeNull();
  });

  it('updateMapMeta renames, edits scaling, validates, and ignores empty names', () => {
    potentialMaps.set([potential('auto-1', 0x10)]);
    a.promoteMap('auto-1');
    const ok = a.updateMapMeta('auto-1', { name: ' Fuel base ', category: 'Fuel', scaling: { factor: 0.75, offset: -48, units: 'kg/h', digits: 2 } });
    expect(ok.ok).toBe(true);
    const m = get(maps)[0]!;
    expect(m.name).toBe('Fuel base');
    expect(m.category).toBe('Fuel');
    expect(m.scaling.factor).toBe(0.75);
    const noop = a.updateMapMeta('auto-1', { name: '   ' });
    expect(noop.ok).toBe(true);
    expect(get(maps)[0]!.name).toBe('Fuel base');
    expect(a.updateMapMeta('ghost', {}).ok).toBe(false);
  });

  it('addImportedMaps validates against the bin and reports skips', () => {
    const good: MapDef = { ...potential('imp-1', 0x10), provenance: 'imported' };
    delete (good as Partial<MapDef>).confidence;
    const oob: MapDef = { ...potential('imp-2', 0xf8, 4, 4), provenance: 'imported' };
    delete (oob as Partial<MapDef>).confidence;
    const { added, skipped } = a.addImportedMaps([good, oob]);
    expect(added).toBe(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('imp-2');
    expect(get(maps).map((m) => m.id)).toEqual(['imp-1']);
  });
});

describe('view params', () => {
  it('adjustColumns clamps to [1, 256]', () => {
    a.adjustColumns(-100);
    expect(get(viewParams).columns).toBe(1);
    a.adjustColumns(1000);
    expect(get(viewParams).columns).toBe(256);
  });

  it('shiftOrigin clamps to [0, size-1]', () => {
    a.shiftOrigin(-5);
    expect(get(viewParams).origin).toBe(0);
    a.shiftOrigin(10_000);
    expect(get(viewParams).origin).toBe(255);
  });

  it('setValueFormat merges and resets the value range', () => {
    viewParams.update((vp) => ({ ...vp, valueRange: { min: 0, max: 10 } }));
    a.setValueFormat({ width: 2, endianness: 'big' });
    const vp = get(viewParams);
    expect(vp.format).toEqual({ width: 2, signed: false, endianness: 'big' });
    expect(vp.valueRange).toBeNull();
  });

  it('cycleViewMode wraps both ways; T order is hex → 2d → 3d → map', () => {
    a.cycleViewMode(1);
    expect(get(viewParams).viewMode).toBe('2d');
    a.cycleViewMode(-1);
    a.cycleViewMode(-1);
    expect(get(viewParams).viewMode).toBe('map');
  });

  it('optimizeValueRange computes min/max over the selection at the view word size', () => {
    a.setSelection(10, 20); // bytes 10..19
    a.optimizeValueRange();
    expect(get(viewParams).valueRange).toEqual({ min: 10, max: 19 });
    a.setValueFormat({ width: 2, endianness: 'big' });
    a.setSelection(10, 20);
    a.optimizeValueRange(); // u16be pairs (10,11).. → 0x0a0b..0x1213
    expect(get(viewParams).valueRange).toEqual({ min: 0x0a0b, max: 0x1213 });
  });

  it('optimizeValueRange without a selection only toasts', () => {
    a.optimizeValueRange();
    expect(get(viewParams).valueRange).toBeNull();
    expect(get(toasts).length).toBeGreaterThan(0);
  });
});

describe('stepPotential (F / Shift+F)', () => {
  it('starts at rank 0, steps in emission order, wraps both ways', () => {
    potentialMaps.set([potential('a', 0x10), potential('b', 0x30), potential('c', 0x50)]);
    a.stepPotential(1);
    expect(get(selection)?.mapId).toBe('a');
    a.stepPotential(1);
    expect(get(selection)?.mapId).toBe('b');
    a.stepPotential(-1);
    a.stepPotential(-1);
    expect(get(selection)?.mapId).toBe('c'); // wrapped backwards from 'a'
  });

  it('with no potentials it toasts and leaves selection alone', () => {
    a.stepPotential(1);
    expect(get(selection)).toBeNull();
    expect(get(toasts).length).toBeGreaterThan(0);
  });
});

describe('pushModal / popModal (global keymap trap while a dialog is open)', () => {
  it('modalOpen is true while any dialog is open, and false again once every one of them closes', () => {
    expect(get(modalOpen)).toBe(false);
    a.pushModal();
    expect(get(modalOpen)).toBe(true);
    a.pushModal(); // two dialogs momentarily open at once — still trapped
    expect(get(modalOpen)).toBe(true);
    a.popModal();
    expect(get(modalOpen)).toBe(true); // one is still open
    a.popModal();
    expect(get(modalOpen)).toBe(false);
  });

  it('popModal never goes negative (defensive against a mismatched close)', () => {
    a.popModal();
    a.popModal();
    expect(get(modalOpen)).toBe(false);
    a.pushModal();
    expect(get(modalOpen)).toBe(true);
  });

  it('resetStores() clears any stuck modal depth', () => {
    a.pushModal();
    a.resetStores();
    expect(get(modalOpen)).toBe(false);
  });
});

describe('project snapshot / apply', () => {
  it('round-trips maps, potentials and value defaults', () => {
    potentialMaps.set([potential('auto-1', 0x10)]);
    a.promoteMap('auto-1');
    potentialMaps.set([potential('auto-2', 0x40)]);
    a.setValueFormat({ width: 2, endianness: 'big' });
    const snap = a.projectSnapshot();
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.value.bin.sha256).toBe(testBin().sha256);
    expect(snap.value.valueDefaults).toEqual({ width: 2, signed: false, endianness: 'big' });
    a.resetStores();
    const dropped = a.applyProject(testBin(), snap.value);
    expect(dropped).toEqual({ droppedMaps: [], droppedPotentials: [], droppedAxisEntries: [], clearedStamps: [] });
    expect(get(maps).map((m) => m.id)).toEqual(['auto-1']);
    expect(get(potentialMaps).map((m) => m.id)).toEqual(['auto-2']);
    expect(get(viewParams).format.width).toBe(2);
    expect(get(regions)).toEqual([]); // regions are scan output — not persisted
  });

  it('drops maps that are out of range for the actually-loaded bin (spec §8)', () => {
    // A project recorded against a 4096-byte bin, reopened against a 256-byte one.
    const manual = (id: string, address: number): MapDef => {
      const { confidence: _c, ...rest } = potential(id, address);
      return { ...rest, provenance: 'manual' };
    };
    a.setBin(createBinImage(new Uint8Array(4096), 'big.bin'));
    maps.set([manual('m-far', 0xf00), manual('m-near', 0x10)]); // 0xF00 fits 4096, not 256
    const snap = a.projectSnapshot();
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    a.resetStores();
    const dropped = a.applyProject(testBin(), snap.value); // 256-byte bin
    expect(dropped.droppedMaps).toHaveLength(1);
    expect(dropped.droppedMaps[0]).toContain('m-far');
    expect(get(maps).map((m) => m.id)).toEqual(['m-near']);
  });

  it('sorts kept confirmed maps by address even when the project JSON has them out of order (hand-edited/external projects), but leaves potentials in engine rank order', () => {
    const image = testBin();
    const manual = (id: string, address: number): MapDef => {
      const { confidence: _c, ...rest } = potential(id, address);
      return { ...rest, provenance: 'manual' };
    };
    const outOfOrder: Project = {
      schemaVersion: 1,
      bin: { name: image.name, sha256: image.sha256, size: image.size },
      valueDefaults: { width: 1, signed: false, endianness: 'little' },
      maps: [manual('m-hi', 0x40), manual('m-lo', 0x10)], // deliberately out of address order
      potentialMaps: [potential('auto-hi', 0x40), potential('auto-lo', 0x10)], // rank order — must NOT be re-sorted
    };
    const dropped = a.applyProject(image, outOfOrder);
    expect(dropped).toEqual({ droppedMaps: [], droppedPotentials: [], droppedAxisEntries: [], clearedStamps: [] });
    expect(get(maps).map((m) => m.id)).toEqual(['m-lo', 'm-hi']);
    expect(get(potentialMaps).map((m) => m.id)).toEqual(['auto-hi', 'auto-lo']);
  });
});

describe('binPath', () => {
  it('starts null and is set by setBinPath', () => {
    expect(get(binPath)).toBeNull();
    a.setBinPath('C:/bins/x.bin');
    expect(get(binPath)).toBe('C:/bins/x.bin');
  });

  it('a new bin clears the previous path', () => {
    a.setBinPath('C:/bins/x.bin');
    a.setBin(testBin());
    expect(get(binPath)).toBeNull();
  });

  it('resetStores clears it', () => {
    a.setBinPath('C:/bins/x.bin');
    a.resetStores();
    expect(get(binPath)).toBeNull();
  });
});

describe('checksumReport', () => {
  it('resetStores clears it', () => {
    a.setChecksumReport({
      familyId: 'ms41', applies: true, blocks: [], valid: true, skipped: [], notes: [],
    });
    a.resetStores();
    expect(get(checksumReport)).toBeUndefined();
  });
});
