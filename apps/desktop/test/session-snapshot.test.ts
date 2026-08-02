import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AxisDef, MapDef } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { captureSession, restoreSession } from '../src/store/session-snapshot.js';
import {
  addressFrame, axisLibrary, bin, binPath, framePromptAnswered, maps, potentialMaps, regions,
  scanStatus, selection, viewParams,
} from '../src/store/stores.js';

function testBin() {
  return createBinImage(Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff), 'undo.bin');
}

function mapAt(id: string, address: number, provenance: MapDef['provenance']): MapDef {
  const xAxis: AxisDef = {
    kind: 'referenced', address: address + 512, count: 4,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: 'rpm', digits: 0 },
  };
  return {
    id, name: `M ${id}`, category: 'Fuel', address, rows: 2, cols: 4,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 0.5, offset: 1, units: 'ms', digits: 2 },
    orientation: 'row-major', provenance, xAxis,
    ...(provenance === 'auto' ? { confidence: 0.8, detector: 'generic' as const } : {}),
  };
}

/** Every store the snapshot claims to cover, as comparable JSON. */
function allStores() {
  return JSON.stringify({
    bin: get(bin)?.sha256 ?? null,
    binPath: get(binPath),
    maps: get(maps),
    potentialMaps: get(potentialMaps),
    axisLibrary: get(axisLibrary),
    regions: get(regions),
    scanStatus: get(scanStatus),
    viewParams: get(viewParams),
    selection: get(selection),
    addressFrame: get(addressFrame),
    framePromptAnswered: get(framePromptAnswered),
  });
}

function populate() {
  a.resetStores();
  a.setBin(testBin());
  a.setBinPath('C:/bins/undo.bin');
  a.addImportedMaps([mapAt('i1', 0x100, 'imported'), mapAt('i2', 0x200, 'imported')]);
  potentialMaps.set([mapAt('p1', 0x300, 'auto')]);
  a.addAxisLibEntry('RPM 4', {
    kind: 'referenced', address: 0x800, count: 4,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 40, offset: 0, units: 'rpm', digits: 0 },
  });
  regions.set([{ start: 0, end: 0x400, kind: 'code' }, { start: 0x400, end: 0x1000, kind: 'data' }]);
  scanStatus.set({ state: 'done' });
  a.setSelection(0x100, 0x108, 4);
  a.setViewMode('2d');
  a.adjustColumns(8);
  a.shiftOrigin(0x40);
  addressFrame.set('ms41full');
  framePromptAnswered.set(true);
}

beforeEach(() => a.resetStores());

describe('captureSession / restoreSession', () => {
  it('restores every session store exactly — including the five a Project loses', () => {
    populate();
    const before = allStores();
    const snap = captureSession();

    // Mutate everything a bulk change would touch.
    a.removeMap('i1');
    potentialMaps.set([]);
    a.setViewMode('hex');
    selection.set(null);
    regions.set([]);
    scanStatus.set({ state: 'idle' });
    addressFrame.set('none');
    framePromptAnswered.set(false);
    a.setBinPath(null);
    expect(allStores()).not.toBe(before);

    restoreSession(snap);
    expect(allStores()).toBe(before);
  });

  it('does NOT drop maps on restore, even ones applyProject would reject', () => {
    // applyProject re-validates against bin size and drops failures; undo must not.
    populate();
    const snap = captureSession();
    a.removeMap('i1');
    a.removeMap('i2');
    expect(get(maps)).toHaveLength(0);
    restoreSession(snap);
    expect(get(maps).map((m) => m.id)).toEqual(['i1', 'i2']);
  });

  it('is a value snapshot: mutating the stores afterwards does not change it', () => {
    populate();
    const snap = captureSession();
    const captured = snap.maps.length;
    a.addImportedMaps([mapAt('i3', 0x400, 'imported')]);
    expect(snap.maps).toHaveLength(captured);
  });
});
