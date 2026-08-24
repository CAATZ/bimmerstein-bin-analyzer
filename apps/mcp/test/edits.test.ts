import { describe, expect, it } from 'vitest';
import type { AxisDef, MapDef } from '@binanalyzer/core';
import { attributeEdits, changedOffsets } from '../src/edits.js';
import type { SourcedMap } from '../src/maps.js';

const gridMap = (over: Partial<MapDef> = {}): MapDef => ({
  id: 'm1',
  name: 'Fuel',
  address: 0x10,
  rows: 2,
  cols: 2,
  format: { width: 1, signed: false, endianness: 'big' },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major',
  provenance: 'imported',
  ...over,
});

const sourced = (map: MapDef, source: SourcedMap['source'] = 'confirmed'): SourcedMap => ({ map, source });

const buffers = (size: number, edits: Record<number, [number, number]>) => {
  const original = new Uint8Array(size);
  const working = new Uint8Array(size);
  for (const [off, [was, now]] of Object.entries(edits)) {
    original[Number(off)] = was;
    working[Number(off)] = now;
  }
  return { original, working };
};

describe('changedOffsets', () => {
  it('is exactly the set of differing offsets', () => {
    const { working, original } = buffers(8, { 2: [1, 5], 6: [3, 3] });
    expect([...changedOffsets(working, original)]).toEqual([2]);
  });
});

describe('cell attribution', () => {
  it('reports a changed cell as one row with its row/col and both values', () => {
    // 2x2 u8 map at 0x10; offset 0x13 is r1,c1.
    const { working, original } = buffers(0x20, { 0x13: [10, 20] });

    const out = attributeEdits({ working, original, maps: [sourced(gridMap())], checksums: [] });

    expect(out.changedBytes).toBe(1);
    expect(out.rows).toEqual([
      {
        kind: 'cell', offset: 0x13, mapId: 'm1', mapName: 'Fuel', source: 'confirmed',
        row: 1, col: 1, original: { raw: 10, value: 10 }, current: { raw: 20, value: 20 },
      },
    ]);
  });

  it('rolls a 2-byte cell up into ONE row when only its high byte changed', () => {
    // width 2, big-endian, at 0x10: cell r0,c0 spans 0x10-0x11.
    const { working, original } = buffers(0x20, { 0x10: [0x01, 0x02] });
    const map = gridMap({ format: { width: 2, signed: false, endianness: 'big' } });

    const out = attributeEdits({ working, original, maps: [sourced(map)], checksums: [] });

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ kind: 'cell', row: 0, col: 0, offset: 0x10 });
    expect(out.rows[0]).toMatchObject({ original: { raw: 0x0100 }, current: { raw: 0x0200 } });
    // Both bytes of the value are consumed even though only one differed.
    expect(out.summary.maps[0]!.bytes).toBe(2);
  });

  it('attributes a byte in BOTH a confirmed and a potential map to the confirmed one', () => {
    const { working, original } = buffers(0x20, { 0x10: [1, 2] });
    const confirmed = sourced(gridMap({ id: 'c1', name: 'Confirmed' }), 'confirmed');
    const potential = sourced(gridMap({ id: 'p1', name: 'Potential' }), 'potential');

    const out = attributeEdits({ working, original, maps: [potential, confirmed], checksums: [] });

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ mapId: 'c1', source: 'confirmed' });
  });

  it('attributes a byte in BOTH an imported and a potential map to the imported one', () => {
    const { working, original } = buffers(0x20, { 0x10: [1, 2] });
    const imported = sourced(gridMap({ id: 'i1', name: 'Imported' }), 'imported');
    const potential = sourced(gridMap({ id: 'p1', name: 'Potential' }), 'potential');

    const out = attributeEdits({ working, original, maps: [potential, imported], checksums: [] });

    expect(out.rows[0]).toMatchObject({ mapId: 'i1', source: 'imported' });
  });

  it('reports NOTHING for a byte that was edited and then put back', () => {
    const { working, original } = buffers(0x20, { 0x13: [7, 7] });

    const out = attributeEdits({ working, original, maps: [sourced(gridMap())], checksums: [] });

    expect(out.changedBytes).toBe(0);
    expect(out.rows).toEqual([]);
    expect(out.summary.maps).toEqual([]);
  });

  it('sorts rows by ascending offset', () => {
    const { working, original } = buffers(0x20, { 0x13: [1, 2], 0x10: [3, 4] });

    const out = attributeEdits({ working, original, maps: [sourced(gridMap())], checksums: [] });

    expect(out.rows.map((r) => r.offset)).toEqual([0x10, 0x13]);
  });
});

const axis = (over: Partial<AxisDef> = {}): AxisDef => ({
  kind: 'referenced',
  address: 0x40,
  count: 4,
  format: { width: 1, signed: false, endianness: 'big' },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  ...over,
});

describe('axis attribution', () => {
  it('reports an axis entry as an axis row, not a cell row', () => {
    // axis at 0x40, u8, index 2 -> offset 0x42. Map data is at 0x10, untouched.
    const { working, original } = buffers(0x60, { 0x42: [30, 44] });
    const map = gridMap({ xAxis: axis() });

    const out = attributeEdits({ working, original, maps: [sourced(map)], checksums: [] });

    expect(out.rows).toEqual([
      {
        kind: 'axis', offset: 0x42, axisAddress: 0x40, index: 2, mapIds: ['m1'],
        original: { raw: 30, value: 30 }, current: { raw: 44, value: 44 },
      },
    ]);
    expect(out.summary.maps[0]).toMatchObject({ cells: 0, axisEntries: 1, bytes: 1 });
  });

  it('reports a SHARED axis once, naming every map that references it', () => {
    const { working, original } = buffers(0x60, { 0x42: [30, 44] });
    const shared = axis({ libId: 'lib-rpm' });
    const m1 = sourced(gridMap({ id: 'm1', xAxis: shared }));
    const m2 = sourced(gridMap({ id: 'm2', address: 0x20, xAxis: shared }));

    const out = attributeEdits({ working, original, maps: [m2, m1], checksums: [] });

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ kind: 'axis', mapIds: ['m1', 'm2'], libId: 'lib-rpm' });
    // Charged to the lowest map id only, so bytes are not double-counted.
    const charged = out.summary.maps.filter((m) => m.axisEntries > 0);
    expect(charged).toHaveLength(1);
    expect(charged[0]!.mapId).toBe('m1');
  });

  it('ignores literal and index axes, which have no bytes in the bin', () => {
    const { working, original } = buffers(0x60, { 0x42: [30, 44] });
    const map = gridMap({
      xAxis: { kind: 'literal', count: 2, values: [1, 2] },
      yAxis: { kind: 'index', count: 2 },
    });

    const out = attributeEdits({ working, original, maps: [sourced(map)], checksums: [] });

    expect(out.rows.filter((r) => r.kind === 'axis')).toEqual([]);
  });

  it('claims a CELL before an axis when a map overlaps its own axis', () => {
    // Pathological but legal: axis address inside the data span.
    const { working, original } = buffers(0x60, { 0x11: [1, 2] });
    const map = gridMap({ xAxis: axis({ address: 0x10 }) });

    const out = attributeEdits({ working, original, maps: [sourced(map)], checksums: [] });

    expect(out.rows[0]!.kind).toBe('cell');
  });
});
