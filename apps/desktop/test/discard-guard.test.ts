import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ms41TuneImage } from './ms41-image.js';
import { FakeHost } from './flows.test.js';
import * as a from '../src/store/actions.js';
import { bin, toasts, workingBytes } from '../src/store/stores.js';
import { confirmCloseFlow, loadBinFromPath, openProjectFlow, saveBinFlow, saveProjectFlow } from '../src/platform/flows.js';

const A = 'C:\\bins\\a.bin';
const B = 'C:\\bins\\b.bin';

const byteMap = (address: number) => ({
  id: 'm', name: 'm', address, rows: 1, cols: 1,
  format: { width: 1 as const, signed: false, endianness: 'little' as const },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major' as const, provenance: 'manual' as const,
});

async function dirtySession(host: FakeHost): Promise<void> {
  host.files.set(A, ms41TuneImage());
  host.files.set(B, ms41TuneImage());
  await loadBinFromPath(host, A);
  a.editCell(byteMap(0x1010), 0, 0, 0x5a);
}

beforeEach(() => a.resetStores());

describe('discard guard', () => {
  it('loading the FIRST bin never asks', async () => {
    const host = new FakeHost();
    host.files.set(A, ms41TuneImage());
    expect(await loadBinFromPath(host, A)).toBe(true);
    expect(host.confirmMessages).toHaveLength(0);
  });

  it('a clean session never asks', async () => {
    const host = new FakeHost();
    host.files.set(A, ms41TuneImage());
    host.files.set(B, ms41TuneImage());
    await loadBinFromPath(host, A);
    await loadBinFromPath(host, B);
    expect(host.confirmMessages).toHaveLength(0);
  });

  it('a dirty session asks, and declining keeps the current bin AND its edits', async () => {
    const host = new FakeHost();
    await dirtySession(host);
    const edited = Uint8Array.from(get(workingBytes)!);
    host.confirmAnswers = [false];
    expect(await loadBinFromPath(host, B)).toBe(false);
    expect(get(bin)?.name).toBe('a.bin');
    expect([...get(workingBytes)!]).toEqual([...edited]);
    expect(host.confirmMessages[0]).toMatch(/unsaved/i);
  });

  it('accepting discards and loads the new bin', async () => {
    const host = new FakeHost();
    await dirtySession(host);
    host.confirmAnswers = [true];
    expect(await loadBinFromPath(host, B)).toBe(true);
    expect(get(bin)?.name).toBe('b.bin');
  });

  it('does NOT ask after saving — the buffer matches the file', async () => {
    const host = new FakeHost();
    await dirtySession(host);
    host.saveAnswers = ['C:\\bins\\out.bin'];
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);
    expect(await loadBinFromPath(host, B)).toBe(true);
    expect(host.confirmMessages).toHaveLength(0);
  });

  it('does NOT ask after undoing back to the saved state', async () => {
    const host = new FakeHost();
    await dirtySession(host);
    host.saveAnswers = ['C:\\bins\\out.bin'];
    await saveBinFlow(host, { promptAlways: true });
    a.editCell(byteMap(0x1011), 0, 0, 0x77);
    expect(a.undo()).toBe(true);
    expect(await loadBinFromPath(host, B)).toBe(true);
    expect(host.confirmMessages).toHaveLength(0);
  });

  it('guards Open Project too', async () => {
    const host = new FakeHost();
    await dirtySession(host);
    host.confirmAnswers = [false];
    await openProjectFlow(host);
    expect(host.confirmMessages[0]).toMatch(/unsaved/i);
    expect(get(bin)?.name).toBe('a.bin');
  });
});

describe('saving a project while the bin is dirty', () => {
  it('warns that the project binds to the file as last saved', async () => {
    const host = new FakeHost();
    await dirtySession(host);
    host.saveAnswers = ['C:\\proj\\a.binproj.json'];
    expect(await saveProjectFlow(host)).toBe(true);
    expect(get(toasts).some((t) => /unsaved/i.test(t.text))).toBe(true);
  });

  it('does not warn on a clean session', async () => {
    const host = new FakeHost();
    host.files.set(A, ms41TuneImage());
    await loadBinFromPath(host, A);
    host.saveAnswers = ['C:\\proj\\a.binproj.json'];
    await saveProjectFlow(host);
    expect(get(toasts).some((t) => /unsaved/i.test(t.text))).toBe(false);
  });
});

describe('closing the app with unsaved byte changes', () => {
  it('a clean session closes with no prompt', async () => {
    const host = new FakeHost();
    host.files.set(A, ms41TuneImage());
    await loadBinFromPath(host, A);
    expect(await confirmCloseFlow(host)).toBe(true);
    expect(host.confirmMessages).toHaveLength(0);
  });

  it('with no bin at all it closes with no prompt', async () => {
    const host = new FakeHost();
    expect(await confirmCloseFlow(host)).toBe(true);
    expect(host.confirmMessages).toHaveLength(0);
  });

  it('a dirty session asks, and declining BLOCKS the close', async () => {
    const host = new FakeHost();
    await dirtySession(host);
    host.confirmAnswers = [false];
    expect(await confirmCloseFlow(host)).toBe(false);
    // The wording names closing, not loading — the load guard's message would be
    // wrong here and the user is being asked about a different loss.
    expect(host.confirmMessages[0]).toMatch(/unsaved/i);
    expect(host.confirmMessages[0]).toMatch(/clos/i);
  });

  it('accepting allows the close', async () => {
    const host = new FakeHost();
    await dirtySession(host);
    host.confirmAnswers = [true];
    expect(await confirmCloseFlow(host)).toBe(true);
  });

  it('does NOT ask after saving', async () => {
    const host = new FakeHost();
    await dirtySession(host);
    host.saveAnswers = ['C:\\bins\\out.bin'];
    expect(await saveBinFlow(host, { promptAlways: true })).toBe(true);
    expect(await confirmCloseFlow(host)).toBe(true);
    expect(host.confirmMessages).toHaveLength(0);
  });

  it('ALLOWS the close when confirm throws — the opposite of the load guard, deliberately', async () => {
    // An app that cannot be quit because a dialog broke is a worse defect than an
    // edit the user can redo, and they can always close again. The load guard
    // takes the other branch because there "safe" means keeping the edits.
    const host = new FakeHost();
    await dirtySession(host);
    host.confirm = async (): Promise<boolean> => {
      throw new Error('dialog unavailable');
    };
    expect(await confirmCloseFlow(host)).toBe(true);
  });
});
