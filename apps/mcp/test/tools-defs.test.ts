import { describe, expect, it } from 'vitest';
import { call, errorText, fakeDeps, payload } from './helpers.js';
import { exportDefinitionTool, importDefinitionTool, openBinTool } from '../src/tools/index.js';

/** A 24 KB direct-framed cal partial: storageaddress === file offset. */
const PARTIAL = new Uint8Array(0x6000).map((_v, i) => i & 0xff);

const DEF = `<?xml version="1.0" encoding="UTF-8"?>
<roms>
<rom>
  <romid><xmlid>TESTROM</xmlid><internalidaddress>0</internalidaddress><internalidstring>TESTROM</internalidstring></romid>
  <table type="3D" name="Fuel" storageaddress="1000" storagetype="uint8" sizex="4" sizey="2">
    <scaling units="ms" expression="x*0.5" to_byte="x/0.5" format="0.00" />
    <table type="X Axis" name="RPM" storagetype="uint8" storageaddress="900" />
    <table type="Y Axis" name="Load" storagetype="uint8" storageaddress="910" />
  </table>
  <table type="2D" name="Warmup" storageaddress="1100" storagetype="uint8" sizex="4">
    <scaling units="%" expression="x" to_byte="x" format="0" />
    <table type="X Axis" name="Temp" storagetype="uint8" storageaddress="920" />
  </table>
</rom>
</roms>`;

async function withDef(): Promise<{ deps: ReturnType<typeof fakeDeps>; binId: string }> {
  const deps = fakeDeps({ bins: { '/b/p.bin': PARTIAL }, texts: { '/d/def.xml': DEF } });
  const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/p.bin' }, deps));
  await call(importDefinitionTool, { binId, path: '/d/def.xml' }, deps);
  return { deps, binId };
}

describe('import_definition', () => {
  it('imports from an inline string with no framing on a partial', async () => {
    const deps = fakeDeps({ bins: { '/b/p.bin': PARTIAL } });
    const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/p.bin' }, deps));
    const r = payload(await call(importDefinitionTool, { binId, xml: DEF }, deps));
    expect(r['romId']).toBe('TESTROM');
    expect(r['frameApplied']).toBe('none');
    expect(r['importedMaps']).toBe(2);
    expect(r['definitionMaps']).toBe(2);
    expect((r['sample'] as unknown[]).length).toBe(2);
    expect(r['byKind']).toEqual({ grid: 1, curve: 1, switch: 0, param: 0 });
  });

  it('imports from a path and makes the maps visible to list/export', async () => {
    const { deps, binId } = await withDef();
    const csv = payload(await call(exportDefinitionTool, { binId, format: 'csv' }, deps));
    expect(csv['maps']).toBe(2);
    expect(String(csv['content'])).toContain('Fuel');
  });

  it('requires exactly one of path / xml', async () => {
    const deps = fakeDeps({ bins: { '/b/p.bin': PARTIAL }, texts: { '/d/def.xml': DEF } });
    const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/p.bin' }, deps));
    expect(errorText(await call(importDefinitionTool, { binId }, deps))).toContain('exactly one');
    expect(errorText(await call(importDefinitionTool, { binId, xml: DEF, path: '/d/def.xml' }, deps))).toContain('exactly one');
  });

  it('reports a replaced previous import', async () => {
    const { deps, binId } = await withDef();
    const again = payload(await call(importDefinitionTool, { binId, xml: DEF }, deps));
    expect(again['replacedPrevious']).toBe(2);
  });

  it('drops out-of-range definitions instead of storing an unreadable map', async () => {
    const tiny = new Uint8Array(512);
    const deps = fakeDeps({ bins: { '/b/tiny.bin': tiny } });
    const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/tiny.bin' }, deps));
    const r = payload(await call(importDefinitionTool, { binId, xml: DEF }, deps));
    expect(r['importedMaps']).toBe(0);
    expect((r['skippedValidation'] as string[]).length).toBe(2);
  });

  it('surfaces a malformed definition as an error', async () => {
    const deps = fakeDeps({ bins: { '/b/p.bin': PARTIAL } });
    const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/p.bin' }, deps));
    expect(await call(importDefinitionTool, { binId, xml: 'not xml at all' }, deps)).toHaveProperty('isError', true);
  });
});

describe('export_definition', () => {
  it('round-trips RomRaider back through the importer', async () => {
    const { deps, binId } = await withDef();
    const out = payload(await call(exportDefinitionTool, { binId, format: 'romraider', romId: 'TESTROM' }, deps));
    expect(out['unframed']).toBe('none');
    const back = payload(await call(importDefinitionTool, { binId, xml: out['content'] }, deps));
    expect(back['importedMaps']).toBe(2);
  });

  it('emits xdf, csv and json', async () => {
    const { deps, binId } = await withDef();
    expect(String(payload(await call(exportDefinitionTool, { binId, format: 'xdf' }, deps))['content'])).toContain('XDFFORMAT');
    expect(String(payload(await call(exportDefinitionTool, { binId, format: 'csv' }, deps))['content'])).toContain('name,category,address');
    expect(JSON.parse(String(payload(await call(exportDefinitionTool, { binId, format: 'json' }, deps))['content']))).toHaveLength(2);
  });

  it('selects an explicit id set', async () => {
    const { deps, binId } = await withDef();
    const all = payload<{ content: string }>(await call(exportDefinitionTool, { binId, format: 'json' }, deps));
    const ids = (JSON.parse(all.content) as Array<{ name: string }>).map((m) => m.name);
    expect(ids).toHaveLength(2);
    const listed = payload(await call(exportDefinitionTool, { binId, format: 'json', source: 'ids', mapIds: ['imported-does-not-exist'] }, deps));
    expect(listed['skipped']).toHaveLength(1);
    expect(listed['maps']).toBe(0);
  });

  it('refuses outPath without --allow-write', async () => {
    const { deps, binId } = await withDef();
    expect(errorText(await call(exportDefinitionTool, { binId, format: 'csv', outPath: '/anywhere/x.csv' }, deps))).toContain('--allow-write');
  });

  it('names scan_bin when asked to export unscanned potentials', async () => {
    const { deps, binId } = await withDef();
    expect(errorText(await call(exportDefinitionTool, { binId, format: 'csv', source: 'potential' }, deps))).toContain('scan_bin');
  });
});
