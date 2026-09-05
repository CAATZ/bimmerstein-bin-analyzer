import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBinImage, sha256Hex } from '@binanalyzer/core';
import { serializeProject } from '@binanalyzer/formats';
import { ms41TuneImage } from './ms41-image.js';
import { FakeHost } from './flows.test.js';
import * as a from '../src/store/actions.js';
import { bin, editJournal, lastSave, saveTarget, toasts, workingBytes } from '../src/store/stores.js';
import { loadBinFromPath, openProjectFlow, saveBinFlow } from '../src/platform/flows.js';

const SRC = 'C:\\bins\\tune.bin';
const OUT = 'C:\\bins\\tuned.bin';

const byteMap = (address: number) => ({
  id: 'm', name: 'm', address, rows: 1, cols: 1,
  format: { width: 1 as const, signed: false, endianness: 'little' as const },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major' as const, provenance: 'manual' as const,
});

async function opened(host: FakeHost, bytes = ms41TuneImage()): Promise<void> {
  host.files.set(SRC, bytes);
  expect(await loadBinFromPath(host, SRC)).toBe(true);
}

beforeEach(() => a.resetStores());
afterEach(() => vi.restoreAllMocks());

describe('saveBinFlow — the happy path', () => {
  it('writes the corrected bytes, records a verified target, and lands the correction in the buffer', async () => {
    const host = new FakeHost();
    await opened(host);
    a.editCell(byteMap(0x1010), 0, 0, 0x5a);
    host.saveAnswers = [OUT];

    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);

    const onDisk = host.files.get(OUT) as Uint8Array;
    expect(onDisk).toBeInstanceOf(Uint8Array);
    expect(onDisk.length).toBe(24 * 1024);
    // The invariant the whole design rests on: memory === disk after a save.
    expect([...get(workingBytes)!]).toEqual([...onDisk]);
    expect(get(saveTarget)).toEqual({
      path: OUT, name: 'tuned.bin', sha256: sha256Hex(onDisk), size: onDisk.length,
    });
    const o = get(lastSave)!;
    expect(o.ok).toBe(true);
    expect(o.ok && o.verdict).toEqual({ kind: 'corrected' });
    expect(o.ok && o.editedBytes).toBe(1);
  });

  it('a second Save Bin reuses the target without prompting', async () => {
    const host = new FakeHost();
    await opened(host);
    a.editCell(byteMap(0x1010), 0, 0, 0x5a);
    host.saveAnswers = [OUT];
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);

    a.editCell(byteMap(0x1011), 0, 0, 0x33);
    host.saveAnswers = []; // no dialog answer left: prompting would fail the save
    expect(await saveBinFlow(host, { promptAlways: false })).toBe(true);
    expect([...(host.files.get(OUT) as Uint8Array)]).toEqual([...get(workingBytes)!]);
  });

  it('Save As always prompts, even with a target', async () => {
    const host = new FakeHost();
    await opened(host);
    host.saveAnswers = [OUT, 'C:\\bins\\other.bin'];
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);
    expect(host.files.has('C:\\bins\\other.bin')).toBe(true);
    expect(get(saveTarget)?.path).toBe('C:\\bins\\other.bin');
  });

  it('saves an unedited image whose stored checksum was already stale, and says so', async () => {
    const host = new FakeHost();
    const stale = ms41TuneImage();
    stale[0x1000 + 0x4e] = stale[0x1000 + 0x4e]! ^ 0xff; // corrupt a stored calibration checksum
    await opened(host, stale);
    host.saveAnswers = [OUT];
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);
    const o = get(lastSave)!;
    expect(o.ok && o.verdict.kind).toBe('corrected');
    expect(o.ok && o.corrected.length).toBeGreaterThan(0);
    expect(o.ok && o.editedBytes).toBe(0); // the user changed nothing; the tool did
  });
});

describe('saveBinFlow — nothing changes unless the file lands', () => {
  it.each(['sibling', 'located'] as const)('protects a project\'s %s source file after replacing another session', async (location) => {
    const host = new FakeHost();
    const bytes = ms41TuneImage();
    const source = location === 'sibling' ? SRC : 'D:\\elsewhere\\renamed.bin';
    const projectPath = 'C:\\bins\\smoke.binproj.json';
    host.files.set(source, bytes);
    host.files.set(projectPath, serializeProject({
      schemaVersion: 3,
      bin: { name: 'tune.bin', size: bytes.length, sha256: sha256Hex(bytes) },
      maps: [], potentialMaps: [],
      valueDefaults: { width: 1, signed: false, endianness: 'little' },
    }));
    a.setBin(createBinImage(new Uint8Array(64), 'previous.bin'));
    a.setBinPath('C:\\bins\\previous.bin');
    host.openAnswers = location === 'sibling' ? [projectPath] : [projectPath, source];
    await openProjectFlow(host);
    expect(get(bin)?.sha256).toBe(sha256Hex(bytes));
    a.editCell(byteMap(0x1010), 0, 0, 0x5a);
    host.saveAnswers = [source];

    expect(await saveBinFlow(host, { promptAlways: true })).toBe(false);
    expect(host.files.get(source)).toEqual(bytes);
    expect(get(saveTarget)).toBeNull();
    const outcome = get(lastSave)!;
    expect(!outcome.ok && outcome.reason).toMatch(/opened/i);
  });

  it('a cancelled dialog writes nothing and mutates nothing', async () => {
    const host = new FakeHost();
    await opened(host);
    a.editCell(byteMap(0x1010), 0, 0, 0x5a);
    const before = Uint8Array.from(get(workingBytes)!);
    host.saveAnswers = [null];
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(false);
    expect(host.files.size).toBe(1); // only the source
    expect([...get(workingBytes)!]).toEqual([...before]);
    expect(get(saveTarget)).toBeNull();
    expect(get(lastSave)).toBeNull(); // a cancel is not an outcome
  });

  it('REFUSES to overwrite the file the bin was loaded from', async () => {
    const host = new FakeHost();
    await opened(host);
    const before = Uint8Array.from(host.files.get(SRC) as Uint8Array);
    host.saveAnswers = ['C:/bins/TUNE.BIN']; // same file, different spelling
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(false);
    expect([...(host.files.get(SRC) as Uint8Array)]).toEqual([...before]);
    expect(get(saveTarget)).toBeNull();
    const o = get(lastSave)!;
    expect(o.ok).toBe(false);
    expect(!o.ok && o.reason).toMatch(/opened/i);
  });

  it('a write that throws leaves the buffer uncorrected and records a failure', async () => {
    const host = new FakeHost();
    await opened(host);
    a.editCell(byteMap(0x1010), 0, 0, 0x5a);
    const before = Uint8Array.from(get(workingBytes)!);
    host.writeBinaryError = new Error('disk full');
    host.saveAnswers = [OUT];
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(false);
    expect([...get(workingBytes)!]).toEqual([...before]);
    expect(get(saveTarget)).toBeNull();
    expect(get(lastSave)?.ok).toBe(false);
  });

  it('a read-back mismatch is a FAILED save: no target, no correction applied', async () => {
    const host = new FakeHost();
    await opened(host);
    a.editCell(byteMap(0x1010), 0, 0, 0x5a);
    const before = Uint8Array.from(get(workingBytes)!);
    // A filesystem that corrupts one byte on the way in.
    const realWrite = host.writeBinary.bind(host);
    host.writeBinary = async (p: string, b: Uint8Array): Promise<void> => {
      const bad = Uint8Array.from(b);
      bad[0] = bad[0]! ^ 0x01;
      await realWrite(p, bad);
    };
    host.saveAnswers = [OUT];
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(false);
    expect([...get(workingBytes)!]).toEqual([...before]);
    expect(get(saveTarget)).toBeNull();
    const o = get(lastSave)!;
    expect(!o.ok && o.reason).toMatch(/verify|match/i);
  });
});

describe('saveBinFlow — verdicts', () => {
  it('an image no module recognises still saves, labelled', async () => {
    const host = new FakeHost();
    await opened(host, Uint8Array.from({ length: 64 }, (_, i) => i));
    host.saveAnswers = [OUT];
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);
    const o = get(lastSave)!;
    expect(o.ok && o.verdict).toEqual({ kind: 'unrecognised' });
    expect([...(host.files.get(OUT) as Uint8Array)]).toEqual([...get(workingBytes)!]);
  });

  it('reports a clean correction by toast, not silently', async () => {
    const host = new FakeHost();
    await opened(host);
    host.saveAnswers = [OUT];
    await saveBinFlow(host, { promptAlways: true });
    expect(get(toasts).some((t) => /tuned\.bin/.test(t.text))).toBe(true);
  });

  it('no bin loaded is refused before any dialog', async () => {
    const host = new FakeHost();
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(false);
    expect(host.files.size).toBe(0);
  });
});

describe('saveBinFlow — overlapping operations', () => {
  it.each(['dialog', 'write', 'read-back'] as const)('keeps a new session untouched after the %s await', async (stage) => {
    const host = new FakeHost();
    await opened(host);
    a.editCell(byteMap(0x1010), 0, 0, 0x5a);
    expect(a.correctForSave()!.changed.length).toBeGreaterThan(0);
    host.saveAnswers = [OUT];
    // Identical original bytes still represent a different loaded session.
    const next = createBinImage(ms41TuneImage(), 'next.bin');
    if (stage === 'dialog') {
      vi.spyOn(host, 'saveFile').mockImplementationOnce(async () => {
        a.setBin(next);
        return OUT;
      });
    } else if (stage === 'write') {
      const write = host.writeBinary.bind(host);
      vi.spyOn(host, 'writeBinary').mockImplementationOnce(async (path, bytes) => {
        await write(path, bytes);
        a.setBin(next);
      });
    } else {
      const read = host.readBinary.bind(host);
      vi.spyOn(host, 'readBinary').mockImplementationOnce(async (path) => {
        const bytes = await read(path);
        a.setBin(next);
        return bytes;
      });
    }

    expect(await saveBinFlow(host, { promptAlways: true })).toBe(stage !== 'dialog');
    expect(host.files.has(OUT)).toBe(stage !== 'dialog');
    expect(get(bin)).toBe(next);
    expect(get(workingBytes)).toEqual(next.bytes);
    expect(get(editJournal).size).toBe(0);
    expect(get(saveTarget)).toBeNull();
    expect(get(lastSave)).toBeNull();
  });

  it.each(['write', 'read-back'] as const)('does not attach an old %s failure to a new session', async (stage) => {
    const host = new FakeHost();
    await opened(host);
    host.saveAnswers = [OUT];
    const failAfterLoad = async (): Promise<never> => {
      a.setBin(createBinImage(ms41TuneImage(), 'next.bin'));
      throw new Error('disk disconnected');
    };
    if (stage === 'write') vi.spyOn(host, 'writeBinary').mockImplementationOnce(failAfterLoad);
    else vi.spyOn(host, 'readBinary').mockImplementationOnce(failAfterLoad);

    expect(await saveBinFlow(host, { promptAlways: true })).toBe(false);
    expect(get(lastSave)).toBeNull();
    expect(get(saveTarget)).toBeNull();
    expect(get(toasts).some((t) => /disk disconnected/.test(t.text))).toBe(true);
  });

  it.each(['table', 'checksum'] as const)('preserves a newer %s edit and its undo history during disk I/O', async (kind) => {
    const host = new FakeHost();
    await opened(host);
    a.editCell(byteMap(0x1010), 0, 0, 0x5a);
    const correction = a.correctForSave()!;
    expect(correction.changed.length).toBeGreaterThan(0);
    const ch = correction.changed[0]!;
    const offset = kind === 'table' ? 0x1011 : ch.offset;
    const value = kind === 'table' ? 0x33 : [0, 1, 2].find((v) => v !== ch.from && v !== ch.to)!;
    const beforeEdit = Uint8Array.from(get(workingBytes)!);
    let newerBytes!: Uint8Array;
    let newerJournal = new Map(get(editJournal));
    const write = host.writeBinary.bind(host);
    vi.spyOn(host, 'writeBinary').mockImplementationOnce(async (path, bytes) => {
      await write(path, bytes);
      a.editCell(byteMap(offset), 0, 0, value);
      newerBytes = Uint8Array.from(get(workingBytes)!);
      newerJournal = new Map(get(editJournal));
    });
    host.saveAnswers = [OUT];

    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);
    expect(host.files.get(OUT)).toEqual(correction.bytes);
    expect(get(workingBytes)).toEqual(newerBytes);
    expect(get(editJournal)).toEqual(newerJournal);
    expect(get(saveTarget)?.sha256).toBe(sha256Hex(correction.bytes));
    expect(a.isDirty()).toBe(true);
    expect(get(toasts).some((t) => /newer edits.*not saved/i.test(t.text))).toBe(true);
    expect(a.undo()).toBe(true);
    expect(get(workingBytes)).toEqual(beforeEdit);
    expect(a.redo()).toBe(true);
    expect(get(workingBytes)).toEqual(newerBytes);
    expect(await saveBinFlow(host, { promptAlways: false })).toBe(true);
    expect(host.files.get(OUT)).toEqual(get(workingBytes));
    expect(a.isDirty()).toBe(false);
  });

  it.each(['dialog', 'write', 'read-back'] as const)('refuses a second save while the first awaits %s and releases the guard afterward', async (stage) => {
    const host = new FakeHost();
    await opened(host);
    host.saveAnswers = [OUT];
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const pause = async (): Promise<void> => { entered(); await pending; };
    if (stage === 'dialog') {
      const save = host.saveFile.bind(host);
      vi.spyOn(host, 'saveFile').mockImplementationOnce(async () => { await pause(); return save(); });
    } else if (stage === 'write') {
      const write = host.writeBinary.bind(host);
      vi.spyOn(host, 'writeBinary').mockImplementationOnce(async (path, bytes) => { await pause(); await write(path, bytes); });
    } else {
      const read = host.readBinary.bind(host);
      vi.spyOn(host, 'readBinary').mockImplementationOnce(async (path) => { await pause(); return read(path); });
    }
    const first = saveBinFlow(host, { promptAlways: true });
    await started;
    host.saveAnswers.push('C:\\bins\\other.bin');
    let second: boolean;
    try {
      second = await saveBinFlow(host, { promptAlways: true });
    } finally {
      release();
      await first;
    }
    expect(second).toBe(false);
    expect(host.files.has('C:\\bins\\other.bin')).toBe(false);
    expect(get(saveTarget)?.path).toBe(OUT);
    expect(get(lastSave)?.ok).toBe(true);
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);
    expect(get(saveTarget)?.path).toBe('C:\\bins\\other.bin');
  });

  it('reports a rejected file dialog and allows a later save', async () => {
    const host = new FakeHost();
    await opened(host);
    vi.spyOn(host, 'saveFile').mockRejectedValueOnce(new Error('dialog unavailable'));
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(false);
    expect(get(lastSave)).toEqual({ ok: false, path: null, reason: 'Save failed: dialog unavailable' });
    host.saveAnswers = [OUT];
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);
  });
});
