import { describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { exportRomRaiderXml, importRomRaiderXml } from '../src/romraider.js';

/** Sample maps written the way the importer would produce them (ids follow `${romId}-0x…`). */
function sampleMaps(): MapDef[] {
  return [
    {
      id: 't1-0xe7e', name: 'Ign', category: 'Ignition', address: 0xe7e, rows: 16, cols: 12,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 0.375, offset: -23.6, units: '°BTDC', digits: 2 },
      orientation: 'row-major', provenance: 'imported', notes: 'Main map.',
      xAxis: {
        kind: 'referenced', address: 0x898, count: 12, name: 'Load',
        format: { width: 2, signed: false, endianness: 'little' },
        scaling: { factor: 1389 / 65535, offset: 0, units: 'mg', digits: 0 },
      },
      yAxis: {
        kind: 'referenced', address: 0x8b2, count: 16, name: 'RPM',
        format: { width: 2, signed: false, endianness: 'little' },
        scaling: { factor: 1, offset: 0, units: 'RPM', digits: 0 },
      },
    },
    {
      id: 't1-0x2ad6', name: 'MAF', address: 0x2ad6, rows: 2, cols: 2,
      format: { width: 2, signed: false, endianness: 'little' },
      scaling: { factor: 0.015625, offset: 0, units: 'kg/hr', digits: 2 },
      orientation: 'row-major', provenance: 'imported',
      xAxis: { kind: 'literal', count: 2, values: [0, 0.02], name: 'Volts' },
      yAxis: { kind: 'literal', count: 2, values: [0, 0.32], name: 'Volts' },
    },
    {
      id: 't1-0x510', name: 'Idle', address: 0x510, rows: 6, cols: 1,
      format: { width: 2, signed: false, endianness: 'big' },
      scaling: { factor: 1, offset: 0, units: 'RPM', digits: 0 },
      orientation: 'row-major', provenance: 'imported',
      yAxis: { kind: 'referenced', address: 0x4f0, count: 6, format: { width: 1, signed: false, endianness: 'little' } },
    },
    {
      id: 't1-0x700', name: 'Curve "x"', address: 0x700, rows: 1, cols: 8,
      format: { width: 1, signed: true, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: '?', digits: 0, rawExpression: 'log(x)' },
      orientation: 'row-major', provenance: 'imported',
    },
    {
      id: 't1-0x7ff', name: 'Scalar', address: 0x7ff, rows: 1, cols: 1,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'imported',
    },
  ];
}

/** Sample switch maps written the way the importer would produce them. */
function sampleSwitchMaps(): MapDef[] {
  return [
    {
      id: 't1-0x300', name: 'O2 Feedback', address: 0x300, rows: 1, cols: 1,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'imported',
      states: [
        { name: 'Off', data: [0x00] },
        { name: 'On', data: [0x0c] }, // sourced from a single-digit import (data="C")
      ],
    },
    {
      id: 't1-0x400', name: 'Fuel Mode', category: 'Fuel', address: 0x400, rows: 4, cols: 1,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'imported', notes: 'Fuel mode select.',
      states: [
        { name: 'Enabled', data: [0x01, 0x00, 0xff, 0xa0] },
        { name: 'Disabled', data: [0x00, 0x00, 0x00, 0x00] },
      ],
    },
  ];
}

describe('exportRomRaiderXml — switch tables', () => {
  it('round-trips switch maps through importRomRaiderXml deep-equal', () => {
    const maps = sampleSwitchMaps();
    const exported = exportRomRaiderXml('T1', maps);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const back = importRomRaiderXml(exported.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.romId).toBe('T1');
    expect(back.value.maps).toEqual(maps);
  });

  it('emits type="Switch" with sizey and raw uppercase 2-digit state data, no scaling/storagetype/endian', () => {
    const xml = (exportRomRaiderXml('T1', sampleSwitchMaps()) as { ok: true; value: string }).value;
    expect(xml).toContain('type="Switch"');
    expect(xml).toContain('sizey="4"');
    expect(xml).toContain('<state name="Enabled" data="01 00 FF A0" />');
    expect(xml).not.toContain('storagetype');
    expect(xml).not.toContain('endian');
    expect(xml).not.toContain('<scaling');
  });

  it('exports a single-digit-imported state byte as 2-digit hex and re-imports to the same bytes', () => {
    const xml = (exportRomRaiderXml('T1', sampleSwitchMaps()) as { ok: true; value: string }).value;
    expect(xml).toContain('data="0C"');
    const back = importRomRaiderXml(xml);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const onState = back.value.maps.find((m) => m.id === 't1-0x300')?.states?.find((s) => s.name === 'On');
    expect(onState?.data).toEqual([0x0c]);
  });

  it('is deterministic', () => {
    const a = exportRomRaiderXml('T1', sampleSwitchMaps());
    const b = exportRomRaiderXml('T1', sampleSwitchMaps());
    expect(a).toEqual(b);
  });
});

describe('exportRomRaiderXml — synthesized-states auto emission (Switch Phase B regression, no new code)', () => {
  it('a states-bearing auto param exports as type="Switch" and reimports with identical states', () => {
    const auto: MapDef = {
      id: 'auto-0x14216-1x1w1be', name: 'Param 0x14216 u8', category: 'Code-referenced parameter',
      address: 0x14216, rows: 1, cols: 1,
      format: { width: 1, signed: false, endianness: 'big' }, // the engine's u8Fmt — width-1 endianness is display-meaningless and reimports normalized to 'little'
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'auto', confidence: 0.3, detector: 'family',
      states: [
        { name: '0x01 (stock)', data: [0x01] },
        { name: '0x02', data: [0x02] },
      ],
    };
    const exported = exportRomRaiderXml('T1', [auto]);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value).toContain('type="Switch"');
    const back = importRomRaiderXml(exported.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.maps).toHaveLength(1);
    // NOT whole-map deep-equal: provenance/confidence/detector/id necessarily
    // change on reimport (true of every auto map). States + geometry must hold.
    expect(back.value.maps[0]).toMatchObject({ address: 0x14216, rows: 1, cols: 1, states: auto.states });
  });
});

describe('exportRomRaiderXml', () => {
  it('round-trips through importRomRaiderXml deep-equal', () => {
    const maps = sampleMaps();
    const exported = exportRomRaiderXml('T1', maps);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const back = importRomRaiderXml(exported.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.romId).toBe('T1');
    expect(back.value.maps).toEqual(maps);
  });

  it('emits family-style attributes: hex addresses without 0x, no endian on width-1, both scaling directions', () => {
    const xml = (exportRomRaiderXml('T1', sampleMaps()) as { ok: true; value: string }).value;
    expect(xml).toContain('storageaddress="E7E"');
    expect(xml).toMatch(/<table type="3D" name="Ign"[^>]*storagetype="uint8"(?![^>]*endian)/);
    expect(xml).toContain('expression="x*0.375-23.6"');
    expect(xml).toContain('to_byte="(x+23.6)/0.375"');
    expect(xml).toContain('format="#.##"');
    expect(xml).toContain('sizex="12"');
    expect(xml).toContain('sizey="16"');
    expect(xml).toContain('<data>0.02</data>');
    expect(xml).toContain('name="Curve &quot;x&quot;"'); // escaping
    expect(xml).not.toContain('to_byte="log'); // non-affine: no inverse emitted
  });

  it('writes the romid block from options', () => {
    const xml = (exportRomRaiderXml('T1', [], { internalIdAddress: 0x1400e, internalIdString: '12' }) as { ok: true; value: string }).value;
    expect(xml).toContain('<internalidaddress>1400E</internalidaddress>');
    expect(xml).toContain('<internalidstring>12</internalidstring>');
  });

  it('rejects col-major maps and referenced axes without address/format', () => {
    const bad = { ...sampleMaps()[0]!, orientation: 'col-major' as const };
    expect(exportRomRaiderXml('T1', [bad]).ok).toBe(false);
    const noAddr = { ...sampleMaps()[0]!, xAxis: { kind: 'referenced' as const, count: 12 } };
    expect(exportRomRaiderXml('T1', [noAddr]).ok).toBe(false);
  });

  it('is deterministic', () => {
    const a = exportRomRaiderXml('T1', sampleMaps());
    const b = exportRomRaiderXml('T1', sampleMaps());
    expect(a).toEqual(b);
  });
});
