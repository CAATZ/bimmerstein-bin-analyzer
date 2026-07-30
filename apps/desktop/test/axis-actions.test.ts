import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AxisDef, MapDef, Project, ValueFormat } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { axisLibrary, maps, potentialMaps } from '../src/store/stores.js';
import { stampAxis } from '../src/lib/axislib.js';

function testBin() {
  return createBinImage(Uint8Array.from({ length: 256 }, (_, i) => i & 0xff), 'test.bin');
}
const u8: ValueFormat = { width: 1, signed: false, endianness: 'little' };
function confirmed(id: string, rows = 2, cols = 4): MapDef {
  return {
    id, name: `M ${id}`, address: 0x10, rows, cols, format: u8,
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major', provenance: 'manual',
  };
}
const rpmAxis: AxisDef = { kind: 'referenced', address: 0x60, count: 4, format: u8 };

beforeEach(() => {
  a.resetStores();
  a.setBin(testBin());
});

describe('setMapAxis', () => {
  it('stamps and removes a slot axis with validation', () => {
    maps.set([confirmed('m1')]);
    const r = a.setMapAxis('m1', 'x', { ...rpmAxis, name: 'RPM', libId: 'e1' });
    expect(r.ok).toBe(true);
    expect(get(maps)[0]!.xAxis).toEqual({ ...rpmAxis, name: 'RPM', libId: 'e1' });
    const gone = a.setMapAxis('m1', 'x', undefined);
    expect(gone.ok).toBe(true);
    expect(get(maps)[0]!.xAxis).toBeUndefined();
  });
  it('rejects a count mismatch (validateMapDef gate) and unknown/potential maps', () => {
    maps.set([confirmed('m1')]);
    expect(a.setMapAxis('m1', 'x', { kind: 'index', count: 7 }).ok).toBe(false);
    expect(get(maps)[0]!.xAxis).toBeUndefined();
    potentialMaps.set([{ ...confirmed('p1'), provenance: 'auto', confidence: 0.5 }]);
    expect(a.setMapAxis('p1', 'x', rpmAxis).ok).toBe(false); // potentials are immutable — attach promotes first
  });
});

describe('axis library CRUD', () => {
  it('addAxisLibEntry mints unique ids and normalizes the stored axis (no name/libId)', () => {
    const r1 = a.addAxisLibEntry('RPM', { ...rpmAxis, name: 'x', libId: 'stale' });
    const r2 = a.addAxisLibEntry('RPM 2', rpmAxis);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.id).not.toBe(r2.value.id);
    expect(r1.value.axis).toEqual(rpmAxis);
    expect(get(axisLibrary)).toHaveLength(2);
  });
  it('addAxisLibEntry rejects invalid entries and stores nothing', () => {
    expect(a.addAxisLibEntry('far', { kind: 'referenced', address: 0xf8, count: 8, format: { width: 2, signed: false, endianness: 'big' } }).ok).toBe(false);
    expect(a.addAxisLibEntry('idx', { kind: 'index', count: 4 }).ok).toBe(false);
    expect(a.addAxisLibEntry('   ', rpmAxis).ok).toBe(false);
    expect(get(axisLibrary)).toEqual([]);
  });
  it('updateAxisLibEntry patches name/axis/notes with validation', () => {
    const r = a.addAxisLibEntry('RPM', rpmAxis, 'note');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const up = a.updateAxisLibEntry(r.value.id, { name: 'RPM (main)', notes: '' });
    expect(up.ok).toBe(true);
    if (up.ok) {
      expect(up.value.name).toBe('RPM (main)');
      expect(up.value.notes).toBeUndefined();
    }
    expect(a.updateAxisLibEntry(r.value.id, { axis: { kind: 'index', count: 4 } }).ok).toBe(false);
    expect(a.updateAxisLibEntry('nope', { name: 'x' }).ok).toBe(false);
  });
});

describe('restamp / detach / remove', () => {
  function setup(): string {
    const r = a.addAxisLibEntry('RPM', rpmAxis);
    if (!r.ok) throw new Error(r.error);
    maps.set([confirmed('m1'), confirmed('m2', 4, 4)]);
    expect(a.setMapAxis('m1', 'x', stampAxis(r.value)).ok).toBe(true);
    expect(a.setMapAxis('m2', 'y', stampAxis(r.value)).ok).toBe(true);
    return r.value.id;
  }
  it('restampAxisLibEntry re-stamps attached maps and reports misfits', () => {
    const id = setup();
    const up = a.updateAxisLibEntry(id, {
      name: 'RPM (main)',
      axis: { ...rpmAxis, scaling: { factor: 0.25, offset: 0, units: 'RPM', digits: 0 } },
    });
    expect(up.ok).toBe(true);
    expect(a.restampAxisLibEntry(id)).toEqual({ updated: 2, skipped: [] });
    expect(get(maps)[0]!.xAxis?.name).toBe('RPM (main)');
    expect(get(maps)[0]!.xAxis?.scaling?.factor).toBe(0.25);
    // a count change makes both sharers misfit → skip+report, old stamps kept inline
    expect(a.updateAxisLibEntry(id, { axis: { ...rpmAxis, count: 6, address: 0x40 } }).ok).toBe(true);
    const res2 = a.restampAxisLibEntry(id);
    expect(res2.updated).toBe(0);
    expect(res2.skipped).toHaveLength(2);
    expect(get(maps)[0]!.xAxis?.count).toBe(4);
  });
  it('detachAxisLibEntry clears stamps but keeps inline axes; removeAxisLibEntry also drops the entry', () => {
    const id = setup();
    expect(a.detachAxisLibEntry(id)).toEqual({ detached: 2 });
    expect(get(maps)[0]!.xAxis).toEqual({ ...rpmAxis, name: 'RPM' });
    expect(get(axisLibrary)).toHaveLength(1);
    const entry = get(axisLibrary)[0]!;
    expect(a.setMapAxis('m1', 'x', stampAxis(entry)).ok).toBe(true);
    expect(a.removeAxisLibEntry(id)).toEqual({ removed: true, detached: 1 });
    expect(get(axisLibrary)).toEqual([]);
    expect(get(maps)[0]!.xAxis?.libId).toBeUndefined();
    expect(a.removeAxisLibEntry(id)).toEqual({ removed: false, detached: 0 });
  });
});

describe('library lifecycle clears', () => {
  it('setBin and resetStores clear the library', () => {
    expect(a.addAxisLibEntry('RPM', rpmAxis).ok).toBe(true);
    a.setBin(testBin());
    expect(get(axisLibrary)).toEqual([]);
    expect(a.addAxisLibEntry('RPM', rpmAxis).ok).toBe(true);
    a.resetStores();
    expect(get(axisLibrary)).toEqual([]);
  });
});

describe('project lifecycle', () => {
  it('snapshot carries the library at schemaVersion 2 and omits it when empty', () => {
    const snapEmpty = a.projectSnapshot();
    expect(snapEmpty.ok).toBe(true);
    if (snapEmpty.ok) {
      expect(snapEmpty.value.schemaVersion).toBe(2);
      expect(snapEmpty.value.axisLibrary).toBeUndefined();
    }
    expect(a.addAxisLibEntry('RPM', rpmAxis).ok).toBe(true);
    const snap = a.projectSnapshot();
    expect(snap.ok).toBe(true);
    if (snap.ok) expect(snap.value.axisLibrary).toHaveLength(1);
  });

  it('applyProject restores the library, drops out-of-range entries and clears dangling stamps', () => {
    const image = testBin(); // 256 bytes — the "wrong smaller bin" of a sha-mismatch load
    const project: Project = {
      schemaVersion: 2,
      bin: { name: 'big.bin', sha256: 'a'.repeat(64), size: 0x2000 },
      valueDefaults: u8,
      axisLibrary: [
        { id: 'lib-ok', name: 'RPM', axis: rpmAxis },
        { id: 'lib-far', name: 'Far', axis: { kind: 'referenced', address: 0x1000, count: 8, format: u8 } },
      ],
      maps: [
        { ...confirmed('m1'), xAxis: { ...rpmAxis, name: 'RPM', libId: 'lib-ok' } },
        { ...confirmed('m2'), xAxis: { ...rpmAxis, name: 'Far', libId: 'lib-far' } },
        { ...confirmed('m3'), xAxis: { ...rpmAxis, name: 'Ghost', libId: 'lib-ghost' } },
      ],
      potentialMaps: [],
    };
    const report = a.applyProject(image, project);
    expect(report.droppedAxisEntries).toEqual(['lib-far ("Far")']);
    expect(report.clearedStamps).toEqual(['m2 ("M m2") x', 'm3 ("M m3") x']);
    expect(get(axisLibrary).map((e) => e.id)).toEqual(['lib-ok']);
    const byId = new Map(get(maps).map((m) => [m.id, m]));
    expect(byId.get('m1')!.xAxis?.libId).toBe('lib-ok');
    expect(byId.get('m2')!.xAxis?.libId).toBeUndefined();
    expect(byId.get('m2')!.xAxis?.name).toBe('Far'); // inline copy survives the detach
    expect(byId.get('m3')!.xAxis?.libId).toBeUndefined();
  });
});
