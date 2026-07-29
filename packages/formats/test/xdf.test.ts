import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { parseXml, type XmlElement } from '../src/xml.js';
import { exportXdf } from '../src/xdf.js';

const GOLDEN = fileURLToPath(new URL('./fixtures/tunerpro-golden.xdf', import.meta.url));

function find(el: XmlElement, name: string, pred: (e: XmlElement) => boolean = () => true): XmlElement | undefined {
  if (el.name === name && pred(el)) return el;
  for (const c of el.children) {
    const r = find(c, name, pred);
    if (r !== undefined) return r;
  }
  return undefined;
}

describe('golden sample lock (TunerPro-written XDF semantics)', () => {
  const root = (() => {
    const r = parseXml(readFileSync(GOLDEN, 'utf8'));
    if (!r.ok) throw new Error(r.error);
    return r.value;
  })();

  it('16-bit little-endian data carries mmedtypeflags 0x02; 8-bit unsigned carries none', () => {
    const main = find(root, 'XDFTABLE', (t) => t.attrs['uniqueid'] === '0x6121')!;
    const z = find(main, 'XDFAXIS', (a) => a.attrs['id'] === 'z')!;
    const embedded = find(z, 'EMBEDDEDDATA')!;
    expect(embedded.attrs['mmedtypeflags']).toBe('0x02');
    expect(embedded.attrs['mmedelementsizebits']).toBe('16');
    const axisTable = find(root, 'XDFTABLE', (t) => t.attrs['uniqueid'] === '0x3E42')!;
    const az = find(axisTable, 'XDFAXIS', (a) => a.attrs['id'] === 'z')!;
    expect(find(az, 'EMBEDDEDDATA')!.attrs['mmedtypeflags']).toBeUndefined();
  });

  it('referenced axes are linked axis-table objects, and axis-table z has rowcount only', () => {
    const main = find(root, 'XDFTABLE', (t) => t.attrs['uniqueid'] === '0x6121')!;
    const x = find(main, 'XDFAXIS', (a) => a.attrs['id'] === 'x')!;
    expect(find(x, 'embedinfo')!.attrs).toMatchObject({ type: '3', linkobjid: '0x3E42' });
    expect(find(x, 'EMBEDDEDDATA')!.attrs['mmedaddress']).toBeUndefined();
    const axisTable = find(root, 'XDFTABLE', (t) => t.attrs['uniqueid'] === '0x3E42')!;
    const embedded = find(find(axisTable, 'XDFAXIS', (a) => a.attrs['id'] === 'z')!, 'EMBEDDEDDATA')!;
    expect(embedded.attrs['mmedrowcount']).toBe('8');
    expect(embedded.attrs['mmedcolcount']).toBeUndefined();
  });

  it('CATEGORYMEM.category is CATEGORY.index + 1', () => {
    const axisTable = find(root, 'XDFTABLE', (t) => t.attrs['uniqueid'] === '0x3E42')!;
    expect(find(axisTable, 'CATEGORYMEM')!.attrs['category']).toBe('21'); // CATEGORY index 0x14 (=20) is "Axis"
  });
});

/** Two maps sharing one referenced axis + one literal-axis map + one signed map. */
function sampleMaps(): MapDef[] {
  const sharedAxis = {
    kind: 'referenced' as const, address: 0x8b2, count: 4, name: 'RPM',
    format: { width: 2 as const, signed: false, endianness: 'little' as const },
    scaling: { factor: 1, offset: 0, units: 'RPM', digits: 0 },
  };
  return [
    {
      id: 'a', name: 'Ign', category: 'Ignition', address: 0xe7e, rows: 4, cols: 3,
      format: { width: 2, signed: false, endianness: 'little' },
      scaling: { factor: 0.375, offset: -23.6, units: 'dBTDC', digits: 2 },
      orientation: 'row-major', provenance: 'imported',
      xAxis: {
        kind: 'referenced', address: 0x898, count: 3, name: 'Load',
        format: { width: 1, signed: false, endianness: 'little' },
        scaling: { factor: 0.05, offset: 0, units: '%', digits: 1 },
      },
      yAxis: sharedAxis,
    },
    {
      id: 'b', name: 'Fuel', category: 'Fuel', address: 0xf00, rows: 4, cols: 2,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: 'ms', digits: 0 },
      orientation: 'row-major', provenance: 'imported',
      xAxis: { kind: 'literal', count: 2, values: [0, 0.02], name: 'Volts' },
      yAxis: sharedAxis,
    },
    {
      id: 'c', name: 'Trim', address: 0xf40, rows: 2, cols: 2,
      format: { width: 1, signed: true, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: '%', digits: 0 },
      orientation: 'row-major', provenance: 'imported',
    },
  ];
}

function exportOk(maps: MapDef[]): string {
  const r = exportXdf('Test Export', 0x40000, maps);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('exportXdf', () => {
  it('emits header, region size, categories (with +1 CATEGORYMEM) and one table per map', () => {
    const root = parseXml(exportOk(sampleMaps()));
    if (!root.ok) throw new Error('unparseable output');
    const doc = root.value;
    expect(doc.name).toBe('XDFFORMAT');
    expect(doc.attrs['version']).toBe('1.70');
    expect(find(doc, 'REGION')!.attrs['size']).toBe('0x40000');
    expect(find(doc, 'BASEOFFSET')!.attrs).toMatchObject({ offset: '0', subtract: '0' });
    const categories = doc.children[0]!.children.filter((c) => c.name === 'CATEGORY').map((c) => c.attrs['name']);
    expect(categories).toEqual(['Ignition', 'Fuel', 'Axis']);
    const ign = find(doc, 'XDFTABLE', (t) => find(t, 'title')?.text === 'Ign')!;
    expect(find(ign, 'CATEGORYMEM')!.attrs['category']).toBe('1'); // CATEGORY index 0x0 + 1
  });

  it('deduplicates shared referenced axes into one linked axis table', () => {
    const doc = (parseXml(exportOk(sampleMaps())) as { ok: true; value: XmlElement }).value;
    const axisTables = doc.children.filter((t) => t.name === 'XDFTABLE' && (find(t, 'title')?.text ?? '').startsWith('Axis - '));
    expect(axisTables).toHaveLength(2); // RPM (shared by Ign+Fuel) and Load — not three
    const rpm = axisTables.find((t) => find(t, 'title')!.text.includes('RPM'))!;
    const uid = rpm.attrs['uniqueid']!;
    const ign = find(doc, 'XDFTABLE', (t) => find(t, 'title')?.text === 'Ign')!;
    const fuel = find(doc, 'XDFTABLE', (t) => find(t, 'title')?.text === 'Fuel')!;
    for (const table of [ign, fuel]) {
      const y = find(table, 'XDFAXIS', (a) => a.attrs['id'] === 'y')!;
      expect(find(y, 'embedinfo')!.attrs).toMatchObject({ type: '3', linkobjid: uid });
      expect(find(y, 'indexcount')!.text).toBe('4');
    }
    const z = find(rpm, 'XDFAXIS', (a) => a.attrs['id'] === 'z')!;
    expect(find(z, 'EMBEDDEDDATA')!.attrs).toMatchObject({
      mmedaddress: '0x8B2', mmedelementsizebits: '16', mmedrowcount: '4', mmedtypeflags: '0x02',
    });
    expect(find(z, 'EMBEDDEDDATA')!.attrs['mmedcolcount']).toBeUndefined();
  });

  it('encodes format flags per the golden sample: 0x02 for 16-bit LE, 0x01 for signed, none for u8', () => {
    const doc = (parseXml(exportOk(sampleMaps())) as { ok: true; value: XmlElement }).value;
    const zOf = (title: string) =>
      find(find(doc, 'XDFTABLE', (t) => find(t, 'title')?.text === title)!, 'XDFAXIS', (a) => a.attrs['id'] === 'z')!;
    expect(find(zOf('Ign'), 'EMBEDDEDDATA')!.attrs['mmedtypeflags']).toBe('0x02');
    expect(find(zOf('Trim'), 'EMBEDDEDDATA')!.attrs['mmedtypeflags']).toBe('0x01');
    expect(find(zOf('Fuel'), 'EMBEDDEDDATA')!.attrs['mmedtypeflags']).toBeUndefined();
    const ignZ = find(zOf('Ign'), 'EMBEDDEDDATA')!;
    expect(ignZ.attrs).toMatchObject({ mmedaddress: '0xE7E', mmedrowcount: '4', mmedcolcount: '3' });
    expect(find(zOf('Ign'), 'MATH', () => true)!.attrs['equation']).toBe('X*0.375-23.6');
  });

  it('renders literal axes as LABELs and absent axes as index LABELs', () => {
    const doc = (parseXml(exportOk(sampleMaps())) as { ok: true; value: XmlElement }).value;
    const fuel = find(doc, 'XDFTABLE', (t) => find(t, 'title')?.text === 'Fuel')!;
    const x = find(fuel, 'XDFAXIS', (a) => a.attrs['id'] === 'x')!;
    expect(x.children.filter((c) => c.name === 'LABEL').map((l) => l.attrs['value'])).toEqual(['0', '0.02']);
    const trim = find(doc, 'XDFTABLE', (t) => find(t, 'title')?.text === 'Trim')!;
    const tx = find(trim, 'XDFAXIS', (a) => a.attrs['id'] === 'x')!;
    expect(tx.children.filter((c) => c.name === 'LABEL').map((l) => l.attrs['value'])).toEqual(['0', '1']);
  });

  it('does not dedupe referenced axes that share address/format but diverge in scaling (would silently mis-scale)', () => {
    const shared = { address: 0x8b2, count: 4, format: { width: 2 as const, signed: false, endianness: 'little' as const } };
    const rpmAxis = { kind: 'referenced' as const, ...shared, name: 'RPM', scaling: { factor: 1, offset: 0, units: 'RPM', digits: 0 } };
    const rawAxis = { kind: 'referenced' as const, ...shared, name: 'Raw', scaling: { factor: 0.5, offset: 0, units: 'raw', digits: 1 } };
    const maps: MapDef[] = [
      { id: 'a', name: 'MapA', address: 0x100, rows: 4, cols: 2, format: { width: 1, signed: false, endianness: 'little' }, scaling: { factor: 1, offset: 0, units: '', digits: 0 }, orientation: 'row-major', provenance: 'imported', yAxis: rpmAxis },
      { id: 'b', name: 'MapB', address: 0x200, rows: 4, cols: 2, format: { width: 1, signed: false, endianness: 'little' }, scaling: { factor: 1, offset: 0, units: '', digits: 0 }, orientation: 'row-major', provenance: 'imported', yAxis: rawAxis },
    ];
    const doc = (parseXml(exportOk(maps)) as { ok: true; value: XmlElement }).value;
    const axisTables = doc.children.filter((t) => t.name === 'XDFTABLE' && (find(t, 'title')?.text ?? '').startsWith('Axis - '));
    expect(axisTables).toHaveLength(2); // same address/format but divergent scaling must NOT collapse to one
    const rpmTable = axisTables.find((t) => find(t, 'title')!.text.includes('RPM'))!;
    const rawTable = axisTables.find((t) => find(t, 'title')!.text.includes('Raw'))!;
    expect(find(find(rpmTable, 'XDFAXIS', (a) => a.attrs['id'] === 'z')!, 'MATH')!.attrs['equation']).toBe('X');
    expect(find(find(rawTable, 'XDFAXIS', (a) => a.attrs['id'] === 'z')!, 'MATH')!.attrs['equation']).toBe('X*0.5');
  });

  it('rejects a literal axis whose values.length does not match its count', () => {
    const bad = { ...sampleMaps()[1]!, xAxis: { kind: 'literal' as const, count: 2, values: [0, 0.02, 0.04], name: 'Volts' } };
    const r = exportXdf('t', 0x1000, [bad]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('literal x axis');
  });

  it('exports an explicit index-kind axis the same as an absent axis (0..count-1 labels, no link)', () => {
    const withIndex = { ...sampleMaps()[2]!, xAxis: { kind: 'index' as const, count: 2 } };
    const doc = (parseXml(exportOk([withIndex])) as { ok: true; value: XmlElement }).value;
    const table = find(doc, 'XDFTABLE', (t) => find(t, 'title')?.text === 'Trim')!;
    const x = find(table, 'XDFAXIS', (a) => a.attrs['id'] === 'x')!;
    expect(find(x, 'embedinfo')).toBeUndefined();
    expect(x.children.filter((c) => c.name === 'LABEL').map((l) => l.attrs['value'])).toEqual(['0', '1']);
  });

  it('combines mmedtypeflags for signed + little-endian multi-byte data (0x03)', () => {
    const signedLE16 = { ...sampleMaps()[0]!, format: { width: 2 as const, signed: true, endianness: 'little' as const } };
    const doc = (parseXml(exportOk([signedLE16])) as { ok: true; value: XmlElement }).value;
    const z = find(find(doc, 'XDFTABLE', (t) => find(t, 'title')?.text === 'Ign')!, 'XDFAXIS', (a) => a.attrs['id'] === 'z')!;
    expect(find(z, 'EMBEDDEDDATA')!.attrs['mmedtypeflags']).toBe('0x03');
  });

  it('rejects col-major and float maps; output is deterministic', () => {
    const colMajor = { ...sampleMaps()[0]!, orientation: 'col-major' as const };
    expect(exportXdf('t', 0x1000, [colMajor]).ok).toBe(false);
    const float = { ...sampleMaps()[2]!, format: { width: 4 as const, signed: false, endianness: 'little' as const, float: true } };
    expect(exportXdf('t', 0x1000, [float]).ok).toBe(false);
    expect(exportOk(sampleMaps())).toBe(exportOk(sampleMaps()));
  });

  it('matches the committed golden output byte-for-byte', async () => {
    await expect(exportOk(sampleMaps())).toMatchFileSnapshot('./fixtures/expected-export.xdf');
  });

  it('exports a canonical N×1 curve with the real axis on X and rowcount 1 (TunerPro 1D convention)', () => {
    const curve: MapDef = {
      id: 'c1', name: 'Curve A', address: 0x510, rows: 6, cols: 1,
      format: { width: 1, signed: false, endianness: 'big' },
      scaling: { factor: 0.5, offset: 0, units: 'deg', digits: 1 },
      orientation: 'row-major', provenance: 'manual',
      yAxis: { kind: 'referenced', address: 0x500, count: 6,
               format: { width: 1, signed: false, endianness: 'big' } },
    };
    const r = exportXdf('t', 0x1000, [curve]);
    expect(r.ok).toBe(true);
    const xml = (r as { ok: true; value: string }).value;
    const table = xml.slice(xml.indexOf('<XDFTABLE'), xml.indexOf('</XDFTABLE>'));
    expect(table).toContain('mmedrowcount="1" mmedcolcount="6"');
    // real axis linked in the X slot (shared-axis embedinfo), dummy Y with indexcount 1
    const xSlot = table.slice(table.indexOf('<XDFAXIS id="x"'), table.indexOf('<XDFAXIS id="y"'));
    const ySlot = table.slice(table.indexOf('<XDFAXIS id="y"'), table.indexOf('<XDFAXIS id="z"'));
    expect(xSlot).toContain('<indexcount>6</indexcount>');
    expect(xSlot).toContain('<embedinfo type="3"');
    expect(ySlot).toContain('<indexcount>1</indexcount>');
    expect(ySlot).not.toContain('<embedinfo');
    // golden 1D dummy Y (tunerpro-golden.xdf:35-46): count-1 label is "0.00",
    // units mirror the table's z units
    expect(ySlot).toContain('<LABEL index="0" value="0.00" />');
    expect(ySlot).toContain('<units>deg</units>');
  });

  it('canonicalizes a 1×N + xAxis curve before export (same output as its N×1 twin)', () => {
    const mk = (rows: number, cols: number, side: 'xAxis' | 'yAxis'): MapDef => ({
      id: 'c2', name: 'Curve B', address: 0x600, rows, cols,
      format: { width: 1, signed: false, endianness: 'big' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'manual',
      [side]: { kind: 'referenced', address: 0x5f0, count: 6,
                format: { width: 1, signed: false, endianness: 'big' } },
    } as MapDef);
    const a = exportXdf('t', 0x1000, [mk(6, 1, 'yAxis')]);
    const b = exportXdf('t', 0x1000, [mk(1, 6, 'xAxis')]);
    expect(a).toEqual(b);
  });
});
