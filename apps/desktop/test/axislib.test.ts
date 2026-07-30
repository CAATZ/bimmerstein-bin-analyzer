import { describe, expect, it } from 'vitest';
import type { AxisDef, AxisLibEntry, MapDef, ValueFormat } from '@binanalyzer/core';
import {
  attachTargets, axisIdentityChanged, axisIdentityKey, detachedAxis, entryAxisFromCurve,
  fanOutCount, libraryAxis, slotCount, stampAxis,
} from '../src/lib/axislib.js';

const u8: ValueFormat = { width: 1, signed: false, endianness: 'little' };
const scaling0 = { factor: 1, offset: 0, units: '', digits: 0 };

function grid(id: string, rows: number, cols: number, over: Partial<MapDef> = {}): MapDef {
  return {
    id, name: id, address: 0x100, rows, cols, format: u8, scaling: scaling0,
    orientation: 'row-major', provenance: 'manual', ...over,
  };
}

const rpmAxis: AxisDef = { kind: 'referenced', address: 0x60, count: 4, format: u8 };
const entry: AxisLibEntry = { id: 'e1', name: 'RPM', axis: rpmAxis };

describe('slot fit + identity', () => {
  it('slotCount mirrors validateMapDef (orientation-swapped)', () => {
    const m = grid('m', 3, 5);
    expect(slotCount(m, 'x')).toBe(5);
    expect(slotCount(m, 'y')).toBe(3);
    const cm = grid('c', 3, 5, { orientation: 'col-major' });
    expect(slotCount(cm, 'x')).toBe(3);
    expect(slotCount(cm, 'y')).toBe(5);
  });
  it('axisIdentityKey: referenced only; scaling excluded; format included', () => {
    expect(axisIdentityKey({ kind: 'literal', count: 2, values: [1, 2] })).toBeUndefined();
    const withScaling: AxisDef = { ...rpmAxis, scaling: { factor: 0.25, offset: 0, units: 'RPM', digits: 0 } };
    expect(axisIdentityKey(withScaling)).toBe(axisIdentityKey(rpmAxis));
    expect(axisIdentityKey({ ...rpmAxis, format: { width: 2, signed: false, endianness: 'big' } }))
      .not.toBe(axisIdentityKey(rpmAxis));
  });
  it('axisIdentityChanged: rename is not an identity change; address/scaling are', () => {
    expect(axisIdentityChanged(rpmAxis, { ...rpmAxis, name: 'renamed' })).toBe(false);
    expect(axisIdentityChanged(rpmAxis, { ...rpmAxis, address: 0x62 })).toBe(true);
    expect(axisIdentityChanged(rpmAxis, { ...rpmAxis, scaling: scaling0 })).toBe(true);
  });
});

describe('stamps', () => {
  it('stampAxis writes entry name + libId; detachedAxis strips only libId; libraryAxis strips name+libId', () => {
    const stamped = stampAxis(entry);
    expect(stamped).toEqual({ ...rpmAxis, name: 'RPM', libId: 'e1' });
    expect(detachedAxis(stamped)).toEqual({ ...rpmAxis, name: 'RPM' });
    expect(libraryAxis(stamped)).toEqual(rpmAxis);
  });
  it('entryAxisFromCurve uses the curve data span', () => {
    const curve = grid('c', 1, 8, { scaling: { factor: 2, offset: 0, units: 'RPM', digits: 0 } });
    expect(entryAxisFromCurve(curve)).toEqual({
      kind: 'referenced', address: 0x100, count: 8, format: u8,
      scaling: { factor: 2, offset: 0, units: 'RPM', digits: 0 },
    });
  });
});

describe('attachTargets + fanOutCount', () => {
  it('filters by dimension, excludes switch maps, marks potentials/suggested/attached', () => {
    const fits = grid('fits', 4, 4); // count 4 fits BOTH slots → two targets
    const wrong = grid('wrong', 3, 5);
    const sw = grid('sw', 4, 1, { states: [{ name: 'Off', data: [0, 0, 0, 0] }] });
    const sharer = grid('sharer', 2, 4, { xAxis: { ...rpmAxis, scaling: { factor: 9, offset: 0, units: '', digits: 0 } } });
    const stampedMap = grid('stamped', 2, 4, { xAxis: stampAxis(entry) });
    const pot = grid('pot', 4, 2, { provenance: 'auto', confidence: 0.5 });
    const targets = attachTargets(entry, [fits, wrong, sw, sharer, stampedMap], [pot]);
    expect(targets.map((t) => `${t.map.id}:${t.slot}`)).toEqual(['fits:x', 'fits:y', 'sharer:x', 'stamped:x', 'pot:y']);
    expect(targets.find((t) => t.map.id === 'sharer')).toMatchObject({ suggested: true, scalingDiffers: true, attached: false, potential: false });
    expect(targets.find((t) => t.map.id === 'stamped')).toMatchObject({ suggested: true, scalingDiffers: false, attached: true });
    expect(targets.find((t) => t.map.id === 'pot')).toMatchObject({ potential: true, slot: 'y', suggested: false });
  });
  it('fanOutCount counts stamped slots on confirmed maps', () => {
    const m1 = grid('m1', 2, 4, { xAxis: stampAxis(entry) });
    const m2 = grid('m2', 4, 4, { xAxis: stampAxis(entry), yAxis: stampAxis(entry) });
    expect(fanOutCount('e1', [m1, m2])).toBe(3);
    expect(fanOutCount('nope', [m1, m2])).toBe(0);
  });
});
