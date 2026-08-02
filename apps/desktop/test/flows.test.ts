import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBinImage } from '@binanalyzer/core';
import type { MapDef } from '@binanalyzer/core';
import { importRomRaiderXml } from '@binanalyzer/formats';
import * as a from '../src/store/actions.js';
import { addressFrame, bin, binPath, maps, potentialMaps, toasts } from '../src/store/stores.js';
import { basename, dirname, joinPath, stemOf, type PlatformHost } from '../src/platform/host.js';
import {
  exportFlow, importDef, loadBinFromPath, openBinFlow, openProjectFlow, saveProjectFlow,
} from '../src/platform/flows.js';

/** In-memory host: scripted dialog answers + a fake filesystem. */
class FakeHost implements PlatformHost {
  files = new Map<string, Uint8Array | string>();
  openAnswers: Array<string | null> = [];
  saveAnswers: Array<string | null> = [];
  confirmAnswers: boolean[] = [];
  confirmMessages: string[] = [];
  existsError: Error | null = null;

  async openFile(): Promise<string | null> {
    return this.openAnswers.shift() ?? null;
  }
  async saveFile(): Promise<string | null> {
    return this.saveAnswers.shift() ?? null;
  }
  async readBinary(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!(f instanceof Uint8Array)) throw new Error(`no binary at ${path}`);
    return f;
  }
  async readText(path: string): Promise<string> {
    const f = this.files.get(path);
    if (typeof f !== 'string') throw new Error(`no text at ${path}`);
    return f;
  }
  async writeText(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  async exists(path: string): Promise<boolean> {
    if (this.existsError) throw this.existsError;
    return this.files.has(path);
  }
  async readTextIfExists(path: string): Promise<string | null> {
    const f = this.files.get(path);
    return typeof f === 'string' ? f : null;
  }
  async confirm(message: string): Promise<boolean> {
    this.confirmMessages.push(message);
    return this.confirmAnswers.shift() ?? false;
  }
  async onFileDrop(): Promise<() => void> {
    return () => {};
  }
}

const BYTES = Uint8Array.from({ length: 64 }, (_, i) => i);

function confirmedMap(id: string, address: number): MapDef {
  return {
    id, name: `M ${id}`, address, rows: 2, cols: 4,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major', provenance: 'manual',
  };
}

beforeEach(() => a.resetStores());

describe('path helpers', () => {
  it('handle both separators', () => {
    expect(basename('C:\\bins\\a.bin')).toBe('a.bin');
    expect(basename('/x/y/a.bin')).toBe('a.bin');
    expect(dirname('C:\\bins\\a.bin')).toBe('C:\\bins');
    expect(joinPath('C:\\bins', 'p.binproj.json')).toBe('C:\\bins\\p.binproj.json');
    expect(joinPath('/x/y', 'a')).toBe('/x/y/a');
    expect(stemOf('a.binproj.json')).toBe('a.binproj');
    expect(stemOf('dump.bin')).toBe('dump');
  });
});

describe('openBinFlow / loadBinFromPath', () => {
  it('loads the picked file into the bin store', async () => {
    const host = new FakeHost();
    host.files.set('C:\\bins\\dump.bin', BYTES);
    host.openAnswers = ['C:\\bins\\dump.bin'];
    expect(await openBinFlow(host)).toBe(true);
    expect(get(bin)?.name).toBe('dump.bin');
    expect(get(bin)?.size).toBe(64);
  });

  it('cancel and read errors are non-events (toast only)', async () => {
    const host = new FakeHost();
    expect(await openBinFlow(host)).toBe(false); // dialog canceled
    expect(await loadBinFromPath(host, 'C:\\missing.bin')).toBe(false);
    expect(get(bin)).toBeNull();
    expect(get(toasts).some((t) => t.kind === 'error')).toBe(true);
  });

  it('rejects empty files', async () => {
    const host = new FakeHost();
    host.files.set('C:\\empty.bin', new Uint8Array(0));
    expect(await loadBinFromPath(host, 'C:\\empty.bin')).toBe(false);
    expect(get(bin)).toBeNull();
  });
});

describe('project save + open (spec §3 sha gate)', () => {
  async function savedProject(host: FakeHost): Promise<string> {
    a.setBin(createBinImage(BYTES, 'dump.bin'));
    maps.set([confirmedMap('m1', 0x10)]);
    potentialMaps.set([{ ...confirmedMap('auto-1', 0x20), provenance: 'auto', confidence: 0.7 }]);
    host.saveAnswers = ['C:\\proj\\dump.binproj.json'];
    await saveProjectFlow(host);
    return 'C:\\proj\\dump.binproj.json';
  }

  it('saves, then reopens via the sibling bin without any confirm', async () => {
    const host = new FakeHost();
    const projPath = await savedProject(host);
    expect(typeof host.files.get(projPath)).toBe('string');
    host.files.set('C:\\proj\\dump.bin', BYTES); // sibling with the recorded name
    a.resetStores();
    host.openAnswers = [projPath];
    await openProjectFlow(host);
    expect(host.confirmMessages).toHaveLength(0);
    expect(get(bin)?.sha256).toBe(createBinImage(BYTES, 'x').sha256);
    expect(get(maps).map((m) => m.id)).toEqual(['m1']);
    expect(get(potentialMaps).map((m) => m.id)).toEqual(['auto-1']);
  });

  it('asks to locate the bin when no sibling exists', async () => {
    const host = new FakeHost();
    const projPath = await savedProject(host);
    host.files.set('D:\\elsewhere\\renamed.bin', BYTES);
    a.resetStores();
    host.openAnswers = [projPath, 'D:\\elsewhere\\renamed.bin'];
    await openProjectFlow(host);
    expect(get(bin)?.name).toBe('renamed.bin');
    expect(get(maps)).toHaveLength(1);
  });

  it('sha mismatch: confirm=false aborts untouched, confirm=true loads', async () => {
    const host = new FakeHost();
    const projPath = await savedProject(host);
    const wrong = Uint8Array.from({ length: 64 }, () => 0xaa);
    host.files.set('C:\\proj\\dump.bin', wrong);
    a.resetStores();
    host.openAnswers = [projPath];
    host.confirmAnswers = [false];
    await openProjectFlow(host);
    expect(host.confirmMessages).toHaveLength(1);
    expect(host.confirmMessages[0]).toContain('sha256');
    expect(get(bin)).toBeNull(); // untouched
    host.openAnswers = [projPath];
    host.confirmAnswers = [true];
    await openProjectFlow(host);
    expect(get(bin)).not.toBeNull();
    expect(get(maps)).toHaveLength(1);
  });

  it('a throwing host.exists() aborts the flow with a toast instead of an unhandled rejection', async () => {
    const host = new FakeHost();
    const projPath = await savedProject(host);
    a.resetStores();
    host.openAnswers = [projPath];
    host.existsError = new Error('scope violation');
    await expect(openProjectFlow(host)).resolves.toBeUndefined();
    expect(get(bin)).toBeNull();
    expect(get(toasts).some((t) => t.kind === 'error' && t.text.includes('scope violation'))).toBe(true);
  });

  it('invalid project JSON toasts and loads nothing', async () => {
    const host = new FakeHost();
    host.files.set('C:\\p.binproj.json', '{"schemaVersion": 99}');
    host.openAnswers = ['C:\\p.binproj.json'];
    await openProjectFlow(host);
    expect(get(bin)).toBeNull();
    expect(get(toasts).some((t) => t.kind === 'error')).toBe(true);
  });

  it('toasts dropped axis library entries and cleared stamps on a mismatched-bin load', async () => {
    const host = new FakeHost();
    const smallBytes = new Uint8Array(64);
    const project = {
      schemaVersion: 2,
      bin: { name: 'dump.bin', sha256: 'a'.repeat(64), size: 0x1000 },
      valueDefaults: { width: 1, signed: false, endianness: 'little' },
      axisLibrary: [
        { id: 'lib-far', name: 'Far', axis: { kind: 'referenced', address: 0x800, count: 8, format: { width: 1, signed: false, endianness: 'little' } } },
      ],
      maps: [{
        id: 'm1', name: 'M', address: 0x10, rows: 2, cols: 4,
        format: { width: 1, signed: false, endianness: 'little' },
        scaling: { factor: 1, offset: 0, units: '', digits: 0 },
        orientation: 'row-major', provenance: 'manual',
        xAxis: {
          kind: 'referenced', address: 0x20, count: 4,
          format: { width: 1, signed: false, endianness: 'little' },
          name: 'Far', libId: 'lib-far',
        },
      }],
      potentialMaps: [],
    };
    // Use the file's 'C:\\proj\\' convention: dirname of a ROOT-level path drops the
    // backslash, joinPath then joins with '/', and FakeHost's exact-key Map lookup
    // misses the sibling bin — the flow would cancel before applyProject.
    host.files.set('C:\\proj\\p.binproj.json', JSON.stringify(project));
    host.files.set('C:\\proj\\dump.bin', smallBytes);
    host.openAnswers = ['C:\\proj\\p.binproj.json'];
    host.confirmAnswers = [true]; // sha mismatch → load anyway
    await openProjectFlow(host);
    expect(get(bin)).not.toBeNull();
    expect(get(toasts).some((t) => t.text.includes('axis library'))).toBe(true);
    expect(get(toasts).some((t) => t.text.includes('detached'))).toBe(true);
    expect(get(maps)[0]!.xAxis?.libId).toBeUndefined();
  });
});

describe('exportFlow', () => {
  beforeEach(() => {
    a.setBin(createBinImage(BYTES, 'dump.bin'));
    maps.set([confirmedMap('m1', 0x10)]);
  });

  it('writes CSV with the frozen header', async () => {
    const host = new FakeHost();
    host.saveAnswers = ['C:\\out\\dump.csv'];
    await exportFlow(host, 'csv');
    const csv = host.files.get('C:\\out\\dump.csv');
    expect(typeof csv).toBe('string');
    expect((csv as string).startsWith('name,category,address,rows,cols,width,signed,endian,factor,offset,units,digits,')).toBe(true);
    expect(csv).toContain('0x10');
  });

  it.each(['romraider', 'xdf', 'json'] as const)('writes a %s export', async (kind) => {
    const host = new FakeHost();
    host.saveAnswers = [`C:\\out\\dump.${kind}`];
    await exportFlow(host, kind);
    const text = host.files.get(`C:\\out\\dump.${kind}`);
    expect(typeof text).toBe('string');
    expect((text as string).length).toBeGreaterThan(0);
  });

  it('CSV/JSON export potentials too — that populates the confidence column', async () => {
    maps.set([]);
    potentialMaps.set([{ ...confirmedMap('auto-1', 0x20), provenance: 'auto', confidence: 0.7 }]);
    const host = new FakeHost();
    host.saveAnswers = ['C:\\out\\dump.csv'];
    await exportFlow(host, 'csv');
    const csv = host.files.get('C:\\out\\dump.csv');
    expect(typeof csv).toBe('string');
    expect(csv).toContain('0.7'); // the potential's confidence
    expect(csv).toContain('0x20');
  });

  it('RomRaider/XDF (curated defs) refuse when there are no confirmed maps, even with potentials', async () => {
    maps.set([]);
    potentialMaps.set([{ ...confirmedMap('auto-1', 0x20), provenance: 'auto', confidence: 0.7 }]);
    const host = new FakeHost();
    host.saveAnswers = ['C:\\out\\dump.xml'];
    await exportFlow(host, 'romraider');
    expect(host.files.size).toBe(0);
    expect(get(toasts).some((t) => t.kind === 'error' && t.text.includes('promote'))).toBe(true);
  });

  it('a canceled save dialog writes nothing and does not toast an error', async () => {
    const host = new FakeHost();
    await exportFlow(host, 'csv'); // saveAnswers empty → null
    expect(host.files.size).toBe(0);
    expect(get(toasts).filter((t) => t.kind === 'error')).toHaveLength(0);
  });
});

import { pickDefFlow } from '../src/platform/flows.js';

const IMPORT_DEF = `<?xml version="1.0"?>
<roms>
<rom>
  <romid><xmlid>T1</xmlid></romid>
  <table type="3D" name="In range" storagetype="uint8" sizex="4" sizey="2" storageaddress="10">
    <scaling units="%" expression="x*0.5" to_byte="x/0.5" format="0.0"/>
    <table type="Static X Axis" name="SX"><data>1</data><data>2</data><data>3</data><data>4</data></table>
    <table type="Static Y Axis" name="SY"><data>1</data><data>2</data></table>
  </table>
  <table type="3D" name="Out of range" storagetype="uint8" sizex="8" sizey="8" storageaddress="FFFF00">
    <table type="Static X Axis" name="SX"><data>1</data><data>2</data><data>3</data><data>4</data><data>5</data><data>6</data><data>7</data><data>8</data></table>
    <table type="Static Y Axis" name="SY"><data>1</data><data>2</data><data>3</data><data>4</data><data>5</data><data>6</data><data>7</data><data>8</data></table>
  </table>
</rom>
</roms>`;

describe('pickDefFlow + importDef', () => {
  beforeEach(() => {
    a.resetStores();
    a.setBin(createBinImage(BYTES, 'dump.bin'));
  });

  it('pickDefFlow reads the file and lists rom ids', async () => {
    const host = new FakeHost();
    host.files.set('C:\\defs\\ms41.xml', IMPORT_DEF);
    host.openAnswers = ['C:\\defs\\ms41.xml'];
    const picked = await pickDefFlow(host);
    expect(picked).not.toBeNull();
    expect(picked!.romIds).toEqual(['T1']);
    expect(picked!.xml).toBe(IMPORT_DEF);
  });

  it('pickDefFlow returns null on cancel and on read errors (with a toast)', async () => {
    const host = new FakeHost();
    expect(await pickDefFlow(host)).toBeNull();
    host.openAnswers = ['C:\\missing.xml'];
    expect(await pickDefFlow(host)).toBeNull();
    expect(get(toasts).some((t) => t.kind === 'error')).toBe(true);
  });

  it('importDef lands in-range maps as imported and skips out-of-range with a toast', async () => {
    const host = new FakeHost();
    await importDef(host, IMPORT_DEF, 'T1');
    const confirmed = get(maps);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.name).toBe('In range');
    expect(confirmed[0]!.provenance).toBe('imported');
    expect(confirmed[0]!.scaling.factor).toBe(0.5);
    expect(get(toasts).some((t) => t.text.includes('skipped 1'))).toBe(true);
  });

  it('importDef surfaces importer errors as a toast', async () => {
    const host = new FakeHost();
    await importDef(host, `<xdf/>`, undefined);
    expect(get(maps)).toHaveLength(0);
    expect(get(toasts).some((t) => t.kind === 'error')).toBe(true);
  });
});

const MINI_DEF = `<roms>
  <rom>
    <romid><xmlid>TESTROM</xmlid></romid>
    <table type="3D" name="Dwell" storagetype="uint16" endian="little" storageaddress="0x670" sizex="2" sizey="2">
      <table type="X Axis" storagetype="uint8" storageaddress="0x660" />
      <table type="Y Axis" storagetype="uint8" storageaddress="0x5F3" />
      <scaling units="ms" expression="x*.0053" to_byte="x/.0053" format="0.00" />
    </table>
  </rom>
</roms>`;

describe('importDef on a full read (2026-07-14 def-frame spec)', () => {
  it('confirm-yes maps addresses through fo(): 0x670→0x14670, axes 0x660→0x14660 / 0x5F3→0x145F3', async () => {
    const host = new FakeHost();
    a.setBin(createBinImage(new Uint8Array(0x18000), 'full.bin'));
    host.confirmAnswers = [true];
    await importDef(host, MINI_DEF, undefined);
    expect(host.confirmMessages).toHaveLength(1);
    expect(get(addressFrame)).toBe('ms41full');
    const m = get(maps)[0]!;
    expect(m.address).toBe(0x14670);
    expect(m.xAxis!.address).toBe(0x14660);
    expect(m.yAxis!.address).toBe(0x145f3);
  });

  it('confirm-no imports addresses as-is and leaves the frame off', async () => {
    const host = new FakeHost();
    a.setBin(createBinImage(new Uint8Array(0x18000), 'full.bin'));
    host.confirmAnswers = [false];
    await importDef(host, MINI_DEF, undefined);
    expect(get(addressFrame)).toBe('none');
    expect(get(maps)[0]!.address).toBe(0x670);
  });

  it('small bins never prompt and import as-is (today’s behavior)', async () => {
    const host = new FakeHost();
    a.setBin(createBinImage(new Uint8Array(0x6000), 'partial.bin'));
    await importDef(host, MINI_DEF, undefined);
    expect(host.confirmMessages).toHaveLength(0);
    expect(get(addressFrame)).toBe('none');
    expect(get(maps)[0]!.address).toBe(0x670);
  });

  it('a second import after yes does not re-prompt', async () => {
    const host = new FakeHost();
    a.setBin(createBinImage(new Uint8Array(0x18000), 'full.bin'));
    host.confirmAnswers = [true];
    await importDef(host, MINI_DEF, undefined);
    await importDef(host, MINI_DEF, undefined); // dup ids get skipped; that's fine
    expect(host.confirmMessages).toHaveLength(1);
    expect(get(addressFrame)).toBe('ms41full');
  });

  it('a decline is remembered for the loaded bin — no re-prompt, still raw', async () => {
    const host = new FakeHost();
    a.setBin(createBinImage(new Uint8Array(0x18000), 'full.bin'));
    host.confirmAnswers = [false];
    await importDef(host, MINI_DEF, undefined);
    await importDef(host, MINI_DEF, undefined);
    expect(host.confirmMessages).toHaveLength(1);
    expect(get(addressFrame)).toBe('none');
    expect(get(maps)[0]!.address).toBe(0x670);
  });

  it('loading a new bin re-arms the prompt after a decline', async () => {
    const host = new FakeHost();
    a.setBin(createBinImage(new Uint8Array(0x18000), 'full.bin'));
    host.confirmAnswers = [false];
    await importDef(host, MINI_DEF, undefined);
    a.setBin(createBinImage(new Uint8Array(0x18000), 'full2.bin'));
    host.confirmAnswers = [true];
    await importDef(host, MINI_DEF, undefined);
    expect(host.confirmMessages).toHaveLength(2);
    expect(get(addressFrame)).toBe('ms41full');
    expect(get(maps)[0]!.address).toBe(0x14670);
  });

  it('opening a project re-arms the prompt (stale decline must not leak to the project bin)', async () => {
    const host = new FakeHost();
    a.setBin(createBinImage(new Uint8Array(0x18000), 'full.bin'));
    host.confirmAnswers = [false];
    await importDef(host, MINI_DEF, undefined); // decline on bin A → flag true
    const image = createBinImage(new Uint8Array(0x18000), 'other-full.bin');
    a.applyProject(image, {
      schemaVersion: 1,
      bin: { name: 'other-full.bin', sha256: image.sha256, size: image.size },
      valueDefaults: { width: 1, signed: false, endianness: 'little' },
      maps: [],
      potentialMaps: [],
    });
    host.confirmAnswers = [true];
    await importDef(host, MINI_DEF, undefined);
    expect(host.confirmMessages).toHaveLength(2); // prompt re-armed for the project's bin
    expect(get(addressFrame)).toBe('ms41full');
  });
});

describe('RomRaider export inverts the frame (fo → SA)', () => {
  it('round-trips: imported-with-frame maps export with the source SAs', async () => {
    const host = new FakeHost();
    a.setBin(createBinImage(new Uint8Array(0x18000), 'full.bin'));
    host.confirmAnswers = [true];
    await importDef(host, MINI_DEF, undefined);
    host.saveAnswers = ['C:\\out.xml'];
    await exportFlow(host, 'romraider');
    const xml = host.files.get('C:\\out.xml');
    expect(typeof xml).toBe('string');
    const back = importRomRaiderXml(xml as string);
    expect(back.ok).toBe(true);
    if (back.ok) {
      const m = back.value.maps[0]!;
      expect(m.address).toBe(0x670);
      expect(m.xAxis!.address).toBe(0x660);
      expect(m.yAxis!.address).toBe(0x5f3);
    }
  });

  it('skips non-cal maps with a warning instead of writing garbage SAs', async () => {
    const host = new FakeHost();
    a.setBin(createBinImage(new Uint8Array(0x18000), 'full.bin'));
    host.confirmAnswers = [true];
    await importDef(host, MINI_DEF, undefined);
    maps.update((ms) => [...ms, confirmedMap('m-code', 0x20)]); // manual map outside cal
    host.saveAnswers = ['C:\\out.xml'];
    await exportFlow(host, 'romraider');
    const xml = host.files.get('C:\\out.xml') as string;
    expect(xml).not.toContain('M m-code');
    expect(get(toasts).some((t) => t.kind === 'error' && t.text.includes('m-code'))).toBe(true);
  });

  it('CSV export stays in file-offset space (no inversion)', async () => {
    const host = new FakeHost();
    a.setBin(createBinImage(new Uint8Array(0x18000), 'full.bin'));
    host.confirmAnswers = [true];
    await importDef(host, MINI_DEF, undefined);
    host.saveAnswers = ['C:\\out.csv'];
    await exportFlow(host, 'csv');
    const csv = host.files.get('C:\\out.csv') as string;
    expect(csv).toContain('14670'); // fo-space address, NOT 670
  });
});

describe('binPath provenance (2026-08-01 co-pilot spec §5.2)', () => {
  it('loadBinFromPath records the path the bytes came from', async () => {
    const host = new FakeHost();
    host.files.set('C:\\bins\\real.bin', Uint8Array.from({ length: 256 }, (_, i) => (i % 251) + 1));
    expect(await loadBinFromPath(host, 'C:\\bins\\real.bin')).toBe(true);
    expect(get(binPath)).toBe('C:\\bins\\real.bin');
  });

  it('a failed load leaves no stale path behind', async () => {
    const host = new FakeHost();
    expect(await loadBinFromPath(host, 'C:\\missing.bin')).toBe(false);
    expect(get(binPath)).toBeNull();
  });
});
