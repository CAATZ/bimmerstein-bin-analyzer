import { describe, expect, it } from 'vitest';
import { importRomRaiderXml } from '../src/romraider.js';

const DEF = `<?xml version="1.0"?>
<roms>
<rom>
  <romid><xmlid>T1</xmlid></romid>
  <table type="3D" name="Ign" category="Ignition" storagetype="uint8" sizex="12" sizey="16" storageaddress="E7E">
    <scaling units="dBTDC" expression="(x*.375)-23.6" to_byte="(x+23.6)/.375" format="0.00"/>
    <table type="X Axis" name="Load" storagetype="uint16" endian="little" storageaddress="0x898">
      <scaling units="mg" expression="x*(1389/65535)" to_byte="x/(1389/65535)" format="#"/>
    </table>
    <table type="Y Axis" name="RPM" storagetype="uint16" endian="little" storageaddress="0x8B2">
      <scaling units="RPM" expression="x" to_byte="x" format="#"/>
    </table>
    <description>Main map.</description>
  </table>
  <table type="3D" name="MAF" storagetype="uint16" endian="little" sizex="2" sizey="2" storageaddress="0x2AD6">
    <scaling units="kg/hr" expression="x*.015625" to_byte="x/.015625" format="0.00"/>
    <table type="Static X Axis" name="Volts"><data>0.00</data><data>0.02</data></table>
    <table type="Static Y Axis" name="Volts"><data>0.00</data><data>0.32</data></table>
  </table>
  <table type="2D" name="Idle" storagetype="uint16" endian="little" sizey="6" storageaddress="510">
    <table type="Y Axis" name="ECT" storagetype="uint8" storageaddress="4F0"/>
  </table>
  <table type="2D" name="Curve" storagetype="uint8" sizex="8" storageaddress="700"/>
  <table type="2D" name="Labeled" storagetype="uint8" sizey="1" storageaddress="7F0">
    <table type="Static Y Axis" name="Bits"><data>Byte 4</data></table>
  </table>
  <table type="2D" name="Weird" storagetype="uint8" sizex="3" storageaddress="7F8">
    <scaling units="?" expr="log(x)" format="0"/>
  </table>
  <table type="Switch" name="EWS" storageaddress="801"><state name="On" data="96"/></table>
  <table type="2D" name="NoAddr" storagetype="uint8" sizey="2"/>
  <table type="2D" name="NoType2" storageaddress="800"/>
  <table name="NoType3" storageaddress="820"/>
</rom>
</roms>`;

function ok(xml: string, romId?: string) {
  const r = importRomRaiderXml(xml, romId);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('importRomRaiderXml (standalone rom)', () => {
  it('imports a 3D table with referenced axes, hex addresses in both forms, decimal sizes', () => {
    const { romId, maps } = ok(DEF);
    expect(romId).toBe('T1');
    const ign = maps.find((m) => m.id === 't1-0xe7e')!;
    expect(ign).toMatchObject({
      name: 'Ign', category: 'Ignition', address: 0xe7e, rows: 16, cols: 12,
      orientation: 'row-major', provenance: 'imported', notes: 'Main map.',
    });
    expect(ign.format).toEqual({ width: 1, signed: false, endianness: 'little' }); // width-1 normalized
    expect(ign.scaling).toMatchObject({ factor: 0.375, offset: -23.6, units: 'dBTDC', digits: 2 });
    expect(ign.xAxis).toMatchObject({ kind: 'referenced', address: 0x898, count: 12 });
    expect(ign.xAxis!.format).toEqual({ width: 2, signed: false, endianness: 'little' });
    expect(ign.xAxis!.scaling!.factor).toBeCloseTo(1389 / 65535, 9);
    expect(ign.yAxis).toMatchObject({ kind: 'referenced', address: 0x8b2, count: 16, name: 'RPM' });
    expect(ign.confidence).toBeUndefined();
  });

  it.each([
    ['uint16', 2, false],
    ['int16', 2, true],
    ['uint32', 4, false],
    ['int32', 4, true],
  ] as const)('defaults %s storagetype without an endian attribute to big-endian (RomRaider convention)', (storagetype, width, signed) => {
    const xml = `<roms><rom><romid><xmlid>NOEND</xmlid></romid>
      <table type="2D" name="NoEndian" storagetype="${storagetype}" sizey="2" storageaddress="900"/>
    </rom></roms>`;
    const { maps } = ok(xml);
    expect(maps.find((m) => m.name === 'NoEndian')!.format).toEqual({ width, signed, endianness: 'big' });
  });

  it('imports static numeric axes as literal values', () => {
    const maf = ok(DEF).maps.find((m) => m.id === 't1-0x2ad6')!;
    expect(maf.xAxis).toMatchObject({ kind: 'literal', count: 2, values: [0, 0.02] });
    expect(maf.yAxis).toMatchObject({ kind: 'literal', count: 2, values: [0, 0.32] });
    expect(maf.xAxis!.address).toBeUndefined();
  });

  it('maps 2D sizey-only to rows×1 and sizex-only to 1×cols', () => {
    const { maps } = ok(DEF);
    expect(maps.find((m) => m.id === 't1-0x510')).toMatchObject({ rows: 6, cols: 1 });
    expect(maps.find((m) => m.id === 't1-0x700')).toMatchObject({ rows: 1, cols: 8 });
  });

  it('demotes non-numeric static axes to index with a warning', () => {
    const { maps, warnings } = ok(DEF);
    const labeled = maps.find((m) => m.id === 't1-0x7f0')!;
    expect(labeled.yAxis).toMatchObject({ kind: 'index', count: 1 });
    expect(warnings.some((w) => w.includes('non-numeric'))).toBe(true);
  });

  it.each(['X', 'Y'] as const)('accepts a scalar Value label on the %s axis without a warning', (role) => {
    for (const type of ['1D', '2D', '3D']) {
      const { maps, warnings } = ok(`<rom><romid><xmlid>SCALAR</xmlid></romid>
        <table type="${type}" name="Counter" storagetype="uint8" sizex="1" sizey="1" storageaddress="100">
          <table type="Static ${role} Axis" name="Value">
            <data> Value </data><scaling units="count" expression="x" format="0"/>
          </table>
        </table></rom>`);
      expect(warnings).toEqual([]);
      expect(maps[0]![role === 'X' ? 'xAxis' : 'yAxis']).toEqual({
        kind: 'index', count: 1, name: 'Value',
        scaling: { factor: 1, offset: 0, units: 'count', digits: 0 },
      });
    }
  });

  it.each([
    ['missing label', '', 1, 1],
    ['empty label', '<data/>', 1, 1],
    ['unknown label', '<data>Invalid</data>', 1, 1],
    ['extra label', '<data>Value</data><data>Value</data>', 1, 1],
    ['curve axis', '<data>Value</data>', 2, 1],
    ['singleton axis on a curve', '<data>Value</data>', 1, 2],
    ['wrong numeric count', '<data>1</data><data>2</data>', 1, 1],
  ])('keeps the warning for %s', (_case, data, rows, cols) => {
    const { warnings } = ok(`<rom><romid><xmlid>BAD</xmlid></romid>
      <table type="2D" name="T" storagetype="uint8" sizey="${rows}" sizex="${cols}" storageaddress="100">
        <table type="Static Y Axis" name="Value">${data}</table>
      </table></rom>`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('using index axis');
  });

  it('keeps numeric scalar axes and scaling warnings on Value labels', () => {
    const xml = `<rom><romid><xmlid>S</xmlid></romid>
      <table type="2D" name="T" storagetype="uint8" sizey="1" storageaddress="100">
        <table type="Static Y Axis" name="Value"><data>Value</data>
          <scaling expression="log(x)"/>
        </table>
      </table></rom>`;
    const text = ok(xml);
    expect(text.warnings).toHaveLength(1);
    expect(text.warnings[0]).toContain('non-affine');
    expect(text.maps[0]!.yAxis!.scaling!.rawExpression).toBe('log(x)');
    const numeric = ok(xml.replace('<data>Value</data>', '<data>7</data>'));
    expect(numeric.maps[0]!.yAxis).toMatchObject({ kind: 'literal', count: 1, values: [7] });
    expect(numeric.warnings).toEqual(text.warnings);
  });

  it('accepts the expr alias and preserves non-affine expressions as rawExpression + warning', () => {
    const { maps, warnings } = ok(DEF);
    const weird = maps.find((m) => m.id === 't1-0x7f8')!;
    expect(weird.scaling).toMatchObject({ factor: 1, offset: 0, rawExpression: 'log(x)' });
    expect(warnings.some((w) => w.includes('non-affine'))).toBe(true);
  });

  it('imports a Switch table with states; addressless/typeless tables still skip with summary warnings', () => {
    const { maps, warnings } = ok(DEF);
    const ews = maps.find((m) => m.name === 'EWS')!;
    expect(ews).toMatchObject({
      address: 0x801, rows: 1, cols: 1,
      format: { width: 1, signed: false, endianness: 'little' },
      states: [{ name: 'On', data: [0x96] }],
      provenance: 'imported',
    });
    expect(ews.scaling).toEqual({ factor: 1, offset: 0, units: '', digits: 0 });
    expect(warnings.some((w) => w.includes('unsupported type') && w.includes('Switch'))).toBe(false);
    for (const name of ['NoAddr', 'NoType2', 'NoType3']) expect(maps.find((m) => m.name === name)).toBeUndefined();
    expect(warnings.some((w) => w.includes('no storageaddress'))).toBe(true);
    // NoType3 (genuinely typeless, "(none)") keeps this bucket exercised now that Switch is supported.
    expect(warnings.some((w) => w.includes('unsupported type'))).toBe(true);
  });

  it('rejects a multi-rom document when romId is omitted', () => {
    const r = importRomRaiderXml(`<roms><rom><romid><xmlid>A</xmlid></romid></rom><rom><romid><xmlid>B</xmlid></romid></rom></roms>`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('A, B');
  });

  it('rejects a non-roms root and an unknown romId with actionable errors', () => {
    expect(importRomRaiderXml(`<xdf/>`).ok).toBe(false);
    const r = importRomRaiderXml(DEF, 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('T1');
  });
});

describe('importRomRaiderXml (Switch tables)', () => {
  it('imports single-digit hex state tokens', () => {
    const xml = `<roms><rom><romid><xmlid>SW1</xmlid></romid>
      <table type="Switch" name="Mode" storageaddress="900" sizey="1">
        <state name="C mode" data="C"/>
      </table>
    </rom></roms>`;
    const { maps } = ok(xml);
    const m = maps.find((m) => m.name === 'Mode')!;
    expect(m.states).toEqual([{ name: 'C mode', data: [0x0c] }]);
  });

  it('imports multi-byte state data (sizey=4)', () => {
    const xml = `<roms><rom><romid><xmlid>SW2</xmlid></romid>
      <table type="Switch" name="Multi" storageaddress="910" sizey="4">
        <state name="Combo" data="01 00 FF a0"/>
      </table>
    </rom></roms>`;
    const { maps } = ok(xml);
    const m = maps.find((m) => m.name === 'Multi')!;
    expect(m.rows).toBe(4);
    expect(m.states).toEqual([{ name: 'Combo', data: [1, 0, 255, 160] }]);
  });

  it('falls back to sizex when sizey is absent', () => {
    const xml = `<roms><rom><romid><xmlid>SW3</xmlid></romid>
      <table type="Switch" name="XOnly" storageaddress="920" sizex="1">
        <state name="On" data="01"/>
      </table>
    </rom></roms>`;
    const { maps } = ok(xml);
    expect(maps.find((m) => m.name === 'XOnly')).toMatchObject({ rows: 1, cols: 1 });
  });

  it('defaults to a single-byte switch when sizex/sizey are both absent', () => {
    const xml = `<roms><rom><romid><xmlid>SW4</xmlid></romid>
      <table type="Switch" name="NoSize" storageaddress="930">
        <state name="On" data="01"/>
      </table>
    </rom></roms>`;
    const { maps } = ok(xml);
    expect(maps.find((m) => m.name === 'NoSize')).toMatchObject({ rows: 1, cols: 1 });
  });

  it('drops malformed states individually, keeping the well-formed ones', () => {
    const xml = `<roms><rom><romid><xmlid>SW5</xmlid></romid>
      <table type="Switch" name="Mixed" storageaddress="940" sizey="1">
        <state name="Good" data="01"/>
        <state name="BadToken" data="1FF"/>
        <state name="WrongCount" data="01 02"/>
      </table>
    </rom></roms>`;
    const { maps, warnings } = ok(xml);
    const m = maps.find((m) => m.name === 'Mixed')!;
    expect(m.states).toEqual([{ name: 'Good', data: [0x01] }]);
    const dropWarnings = warnings.filter((w) => /state .* — state dropped/.test(w));
    expect(dropWarnings).toHaveLength(2);
  });

  it('skips the whole table when every state is malformed, with an explanatory warning', () => {
    const xml = `<roms><rom><romid><xmlid>SW6</xmlid></romid>
      <table type="Switch" name="AllBad" storageaddress="950" sizey="1">
        <state name="Bad1" data="1FF"/>
        <state name="Bad2" data="01 02"/>
      </table>
    </rom></roms>`;
    const { maps, warnings } = ok(xml);
    expect(maps.find((m) => m.name === 'AllBad')).toBeUndefined();
    expect(warnings.some((w) => /switch has no well-formed states — skipped/.test(w))).toBe(true);
  });

  it('drops states missing a name or missing data, each with a dedicated warning', () => {
    const xml = `<roms><rom><romid><xmlid>SW7</xmlid></romid>
      <table type="Switch" name="Missing" storageaddress="960" sizey="1">
        <state name="Good" data="01"/>
        <state data="02"/>
        <state name="NoData"/>
      </table>
    </rom></roms>`;
    const { maps, warnings } = ok(xml);
    const m = maps.find((m) => m.name === 'Missing')!;
    expect(m.states).toEqual([{ name: 'Good', data: [0x01] }]);
    const missingWarnings = warnings.filter((w) => w.includes('missing name/data — state dropped'));
    expect(missingWarnings).toHaveLength(2);
  });

  it('carries category and description to map.category/map.notes', () => {
    const xml = `<roms><rom><romid><xmlid>SW8</xmlid></romid>
      <table type="Switch" name="Cat" category="Ignition" storageaddress="970" sizey="1">
        <state name="On" data="01"/>
        <description>Ignition mode switch.</description>
      </table>
    </rom></roms>`;
    const { maps } = ok(xml);
    const m = maps.find((m) => m.name === 'Cat')!;
    expect(m.category).toBe('Ignition');
    expect(m.notes).toBe('Ignition mode switch.');
  });

  it('counts an address-less switch in the existing no-address summary', () => {
    const xml = `<roms><rom><romid><xmlid>SW9</xmlid></romid>
      <table type="Switch" name="NoAddrSwitch" sizey="1">
        <state name="On" data="01"/>
      </table>
    </rom></roms>`;
    const { maps, warnings } = ok(xml);
    expect(maps.find((m) => m.name === 'NoAddrSwitch')).toBeUndefined();
    expect(warnings.some((w) => w.includes('no storageaddress'))).toBe(true);
  });
});
