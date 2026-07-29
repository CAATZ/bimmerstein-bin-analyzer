import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importRomRaiderXml } from '../src/romraider.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/ms41-style-chain.xml', import.meta.url));
const REAL_DEF = fileURLToPath(new URL('../../../fixtures/ms41/defs/2023 MS41 ECU Definitions.xml', import.meta.url));

function ok(xml: string, romId?: string) {
  const r = importRomRaiderXml(xml, romId);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('inheritance chain resolution', () => {
  const xml = readFileSync(FIXTURE, 'utf8');

  it('merges base structure with derived addresses; axes merge by role (nameless overrides)', () => {
    const { maps } = ok(xml, '12');
    const ign = maps.find((m) => m.id === '12-0xe7e')!;
    expect(ign).toMatchObject({ name: 'Ignition Base', rows: 16, cols: 12, address: 0xe7e });
    // base axis NAME + storagetype survive; derived supplies only the address
    expect(ign.xAxis).toMatchObject({ kind: 'referenced', address: 0x898, count: 12, name: 'Load' });
    expect(ign.xAxis!.format).toEqual({ width: 2, signed: false, endianness: 'little' });
    expect(ign.yAxis).toMatchObject({ kind: 'referenced', address: 0x8b2, count: 16, name: 'Engine Speed' });
    expect(ign.scaling).toMatchObject({ factor: 0.375, offset: -23.6, units: '°BTDC', digits: 2 });
  });

  it('merges <scaling> attribute-wise: derived units/format override, base expression survives', () => {
    const maf = ok(xml, '12').maps.find((m) => m.id === '12-0x2ad6')!;
    expect(maf.scaling).toMatchObject({ factor: 0.015625, offset: 0, units: 'kg/hr [x2]', digits: 1 });
    expect(maf.xAxis).toMatchObject({ kind: 'literal', count: 2, values: [0, 0.02] });
  });

  it('resolves grandparent chains (leaf inherits MIDBASE addresses untouched)', () => {
    expect(ok(xml, '12').maps.find((m) => m.id === '12-0x510')).toMatchObject({ rows: 6, cols: 1, name: 'Idle Target' });
  });

  it('picks the duplicate-xmlid candidate that imports the most maps, with a warning', () => {
    const { maps, warnings } = ok(xml, '12');
    expect(maps).toHaveLength(3); // 24KB chain wins over the 256KB variant (1 map)
    expect(warnings.some((w) => w.includes('share xmlid'))).toBe(true);
  });

  it('still resolves the mid and base roms directly by their xmlid', () => {
    expect(ok(xml, 'MIDBASE').maps).toHaveLength(3);
    expect(ok(xml, 'FAMBASE').maps).toHaveLength(0); // base has structure but no addresses
  });

  it('warns and truncates on a missing base rom instead of failing', () => {
    const { maps, warnings } = ok(`<roms><rom base="GHOST"><romid><xmlid>L</xmlid></romid><table type="2D" name="T" storagetype="uint8" sizey="2" storageaddress="10"/></rom></roms>`, 'L');
    expect(maps).toHaveLength(1);
    expect(warnings.some((w) => w.includes('GHOST'))).toBe(true);
  });

  it('replaces static-axis <data> wholesale when a derived rom overrides it (not merged element-wise)', () => {
    const xml = `<roms>
      <rom><romid><xmlid>DBASE</xmlid></romid>
        <table type="2D" name="T" storagetype="uint8" sizey="3" storageaddress="100">
          <table type="Static Y Axis" name="Volts"><data>0</data><data>1</data><data>2</data></table>
        </table>
      </rom>
      <rom base="DBASE"><romid><xmlid>DLEAF</xmlid></romid>
        <table name="T">
          <table type="Static Y Axis"><data>10</data><data>20</data><data>30</data></table>
        </table>
      </rom>
    </roms>`;
    const t = ok(xml, 'DLEAF').maps.find((m) => m.name === 'T')!;
    expect(t.yAxis).toMatchObject({ kind: 'literal', count: 3, values: [10, 20, 30] });
  });

  it('flips a base Static X Axis to a derived referenced X Axis, keeping the base-supplied name', () => {
    const xml = `<roms>
      <rom><romid><xmlid>FBASE</xmlid></romid>
        <table type="2D" name="T2" storagetype="uint8" sizex="4" storageaddress="200">
          <table type="Static X Axis" name="Gear"><data>1</data><data>2</data><data>3</data><data>4</data></table>
        </table>
      </rom>
      <rom base="FBASE"><romid><xmlid>FLEAF</xmlid></romid>
        <table name="T2">
          <table type="X Axis" storagetype="uint16" endian="little" storageaddress="0x300"/>
        </table>
      </rom>
    </roms>`;
    const t2 = ok(xml, 'FLEAF').maps.find((m) => m.name === 'T2')!;
    expect(t2.xAxis).toMatchObject({ kind: 'referenced', address: 0x300, count: 4, name: 'Gear' });
    expect(t2.xAxis!.format).toEqual({ width: 2, signed: false, endianness: 'little' });
  });

  it('imports derived Switch states while the base-only import skips (stateless base carries the address)', () => {
    const xml = `<roms>
      <rom><romid><xmlid>SWBASE</xmlid></romid>
        <table type="Switch" name="O2 Feedback" storageaddress="500">
          <description>Byte 6 - O2 Feedback</description>
        </table>
      </rom>
      <rom base="SWBASE"><romid><xmlid>SWLEAF</xmlid></romid>
        <table name="O2 Feedback">
          <state name="Off" data="00"/>
          <state name="On" data="01"/>
        </table>
      </rom>
    </roms>`;
    const leaf = ok(xml, 'SWLEAF');
    const t = leaf.maps.find((m) => m.name === 'O2 Feedback')!;
    expect(t.states).toEqual([{ name: 'Off', data: [0] }, { name: 'On', data: [1] }]);
    const base = ok(xml, 'SWBASE');
    expect(base.maps.find((m) => m.name === 'O2 Feedback')).toBeUndefined();
    expect(base.warnings.some((w) => /switch has no well-formed states — skipped/.test(w))).toBe(true);
  });

  it('inherits base Switch states unchanged when the derived rom overrides only the address', () => {
    const xml = `<roms>
      <rom><romid><xmlid>SW3BASE</xmlid></romid>
        <table type="Switch" name="Feedback" storageaddress="520">
          <state name="Off" data="00"/>
          <state name="On" data="01"/>
        </table>
      </rom>
      <rom base="SW3BASE"><romid><xmlid>SW3LEAF</xmlid></romid>
        <table name="Feedback" storageaddress="530">
        </table>
      </rom>
    </roms>`;
    const { maps } = ok(xml, 'SW3LEAF');
    const t = maps.find((m) => m.name === 'Feedback')!;
    expect(t.address).toBe(0x530);
    expect(t.states).toEqual([
      { name: 'Off', data: [0] },
      { name: 'On', data: [1] },
    ]);
  });

  it('replaces Switch states wholesale on override (derived state count wins, never concatenates)', () => {
    const xml = `<roms>
      <rom><romid><xmlid>SW2BASE</xmlid></romid>
        <table type="Switch" name="Mode" storageaddress="510">
          <state name="A" data="00"/>
          <state name="B" data="01"/>
        </table>
      </rom>
      <rom base="SW2BASE"><romid><xmlid>SW2LEAF</xmlid></romid>
        <table name="Mode">
          <state name="X" data="10"/>
          <state name="Y" data="11"/>
          <state name="Z" data="12"/>
        </table>
      </rom>
    </roms>`;
    const { maps } = ok(xml, 'SW2LEAF');
    const t = maps.find((m) => m.name === 'Mode')!;
    expect(t.states).toEqual([
      { name: 'X', data: [0x10] },
      { name: 'Y', data: [0x11] },
      { name: 'Z', data: [0x12] },
    ]);
  });
});

describe.skipIf(!existsSync(REAL_DEF))('real MS41 def (local only, skipped in CI)', () => {
  it('resolves the rom-12 chain of the 2023 MS41 ECU Definitions', () => {
    const { maps } = ok(readFileSync(REAL_DEF, 'utf8'), '12');
    const ign = maps.find((m) => m.id === '12-0xe7e')!;
    expect(ign).toMatchObject({ name: 'Ignition Timing - Base', rows: 16, cols: 12 });
    expect(ign.xAxis).toMatchObject({ kind: 'referenced', address: 0x898, count: 12 });
    expect(ign.yAxis).toMatchObject({ kind: 'referenced', address: 0x8b2, count: 16 });
    expect(maps.length).toBeGreaterThan(100);
  });
});
