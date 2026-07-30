import { describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { exportMapListCsv, exportMapListJson, toMapListRecord } from '../src/maplist.js';

function sampleMaps(): MapDef[] {
  return [
    {
      id: 'a', name: 'Ignition, "Base"', category: 'Ignition', address: 0x1448c, rows: 16, cols: 12,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 0.375, offset: -23.6, units: '°BTDC', digits: 2 },
      orientation: 'row-major', provenance: 'imported',
      xAxis: { kind: 'referenced', address: 0x14898, count: 12, format: { width: 2, signed: false, endianness: 'little' } },
      yAxis: { kind: 'referenced', address: 0x148b2, count: 16, format: { width: 2, signed: false, endianness: 'little' } },
    },
    {
      id: 'b', name: 'MAF', address: 0x16ad6, rows: 16, cols: 16,
      format: { width: 2, signed: true, endianness: 'big' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'auto', confidence: 0.87, detector: 'family',
      xAxis: { kind: 'literal', count: 16, values: Array.from({ length: 16 }, (_, i) => i) },
    },
    {
      id: 'c', name: 'Flex Fuel Enable', category: 'Switches', address: 0x2000, rows: 1, cols: 1,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'imported',
      states: [
        { name: 'Off', data: [0] },
        { name: 'On', data: [1] },
      ],
    },
    {
      id: 'auto-0x142dc-1x1w1be',
      name: 'Param 0x142DC u8',
      category: 'Code-referenced parameter',
      address: 0x142dc,
      rows: 1,
      cols: 1,
      format: { width: 1, signed: false, endianness: 'big' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major',
      provenance: 'auto',
      confidence: 0.3,
      detector: 'family',
    },
  ];
}

const HEADER =
  'name,category,address,rows,cols,width,signed,endian,factor,offset,units,digits,xAxisAddress,xAxisCount,yAxisAddress,yAxisCount,confidence,provenance,detector,kind';

describe('exportMapListCsv', () => {
  it('emits the FROZEN header and one RFC-4180 row per map', () => {
    const r = exportMapListCsv(sampleMaps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = r.value.split('\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe('"Ignition, ""Base""",Ignition,0x1448c,16,12,1,false,little,0.375,-23.6,°BTDC,2,0x14898,12,0x148b2,16,,imported,,'); // imported → empty detector; empty kind (grid)
    expect(lines[2]).toBe('MAF,,0x16ad6,16,16,2,true,big,1,0,,0,,,,,0.87,auto,family,'); // literal axis → empty axis cells; detector column; empty kind
    expect(lines[3]).toBe('Flex Fuel Enable,Switches,0x2000,1,1,1,false,little,1,0,,0,,,,,,imported,,switch'); // switch map → kind: switch
    expect(lines[4]).toBe('Param 0x142DC u8,Code-referenced parameter,0x142dc,1,1,1,false,big,1,0,,0,,,,,0.3,auto,family,param'); // 1×1 stateless → kind: param
    expect(r.value.endsWith('\n')).toBe(true);
    expect(r.value.at(-2)).not.toBe('\n'); // exactly one trailing newline
  });

  it('is deterministic and preserves input order', () => {
    expect(exportMapListCsv(sampleMaps())).toEqual(exportMapListCsv(sampleMaps()));
  });

  it('matches the committed golden CSV', async () => {
    const r = exportMapListCsv(sampleMaps());
    if (!r.ok) throw new Error(r.error);
    await expect(r.value).toMatchFileSnapshot('./fixtures/expected-maplist.csv');
  });
});

describe('exportMapListJson', () => {
  it('emits the same records as an object array with nulls for empty cells', () => {
    const r = exportMapListJson(sampleMaps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const records = JSON.parse(r.value) as unknown[];
    expect(records).toHaveLength(4);
    expect(records[0]).toEqual({
      name: 'Ignition, "Base"', category: 'Ignition', address: '0x1448c', rows: 16, cols: 12,
      width: 1, signed: false, endian: 'little', factor: 0.375, offset: -23.6, units: '°BTDC', digits: 2,
      xAxisAddress: '0x14898', xAxisCount: 12, yAxisAddress: '0x148b2', yAxisCount: 16,
      confidence: null, provenance: 'imported', detector: null, kind: null,
    });
    expect(records[1]).toMatchObject({ confidence: 0.87, detector: 'family', xAxisAddress: null, xAxisCount: null, kind: null });
    expect(records[2]).toMatchObject({ name: 'Flex Fuel Enable', provenance: 'imported', kind: 'switch' });
    expect(records[3]).toMatchObject({ name: 'Param 0x142DC u8', detector: 'family', kind: 'param' });
  });

  it('matches the committed golden JSON', async () => {
    const r = exportMapListJson(sampleMaps());
    if (!r.ok) throw new Error(r.error);
    await expect(r.value).toMatchFileSnapshot('./fixtures/expected-maplist.json');
  });
});

describe('toMapListRecord', () => {
  it('mirrors the CSV column semantics exactly (single authority for both exports)', () => {
    const rec = toMapListRecord(sampleMaps()[1]!);
    expect(rec.endian).toBe('big');
    expect(rec.signed).toBe(true);
    expect(rec.yAxisAddress).toBeNull();
    expect(rec.kind).toBeNull();
  });

  it('reports kind: "switch" for a states-bearing map', () => {
    const rec = toMapListRecord(sampleMaps()[2]!);
    expect(rec.kind).toBe('switch');
  });

  it('reports kind: "param" for a 1×1 stateless map and "switch" for a 1×1 states-bearing one (switch wins)', () => {
    expect(toMapListRecord(sampleMaps()[3]!).kind).toBe('param');
    expect(toMapListRecord(sampleMaps()[2]!).kind).toBe('switch');
  });
});

describe('axis library stamps', () => {
  it('never emits libId in CSV or JSON output (stamps are project-file-only)', () => {
    const maps = sampleMaps();
    const first = maps[0]!;
    const stamped: MapDef[] = [{ ...first, xAxis: { ...first.xAxis!, libId: 'lib-x' } }, ...maps.slice(1)];
    const csv = exportMapListCsv(stamped);
    const json = exportMapListJson(stamped);
    expect(csv.ok).toBe(true);
    expect(json.ok).toBe(true);
    if (!csv.ok || !json.ok) return;
    expect(csv.value).not.toContain('libId');
    expect(json.value).not.toContain('libId');
    const plain = exportMapListCsv(maps);
    if (plain.ok) expect(csv.value).toBe(plain.value); // byte-identical to the unstamped export
  });
});
