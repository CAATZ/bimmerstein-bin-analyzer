import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBinImage, type MapDef } from '@binanalyzer/core';
import { identifyBin } from '@binanalyzer/families';
import { parsePack, serializePack, type MapPack } from '@binanalyzer/formats';
import * as a from '../src/store/actions.js';
import { exportPackFlow, openPackFlow } from '../src/platform/flows.js';
import { pendingPack, toasts, workingBytes } from '../src/store/stores.js';
import { ms41TuneImage } from './ms41-image.js';
import { FakeHost } from './flows.test.js';

const packJson = (calId: string): string =>
  serializePack({
    schemaVersion: 1,
    source: { familyId: 'ms41', calId, binSha256: 'a'.repeat(64) },
    title: 'T',
    tables: [
      {
        name: 'T',
        address: 0x1200,
        rows: 1,
        cols: 2,
        orientation: 'row-major',
        format: { width: 1, signed: false, endianness: 'little' },
        scaling: { factor: 1, offset: 0, units: '', digits: 0 },
        values: [[1, 2]],
        baseline: [[0, 0]],
      },
    ],
  } satisfies MapPack);

const lastToast = (): string => get(toasts).at(-1)?.text ?? '';

/** FakeHost is the shared in-memory host, already exported from flows.test.ts. */
const hostWithPack = (json: string): FakeHost => {
  const h = new FakeHost();
  h.openAnswers = ['/p.binpack.json'];
  h.files.set('/p.binpack.json', json);
  return h;
};

/**
 * The synthetic 24 KB fixture carries no romid — real firmware does, at 0xE —
 * so tests that exercise the CAL-ID gate must plant one. calIdOf reads the
 * leading field up to the first '0'.
 */
const tuneWithId = (calId: string): Uint8Array => {
  const d = ms41TuneImage();
  const romid = `${calId}0${'1'.repeat(12)}`.slice(0, 12);
  for (let i = 0; i < romid.length; i++) d[0x0e + i] = romid.charCodeAt(i);
  return d;
};

const seed = (): void => {
  a.resetStores();
  a.setBin(createBinImage(tuneWithId('12'), 'tune.bin'));
};

describe('openPackFlow', () => {
  beforeEach(seed);

  it('refuses a pack whose CAL-ID differs, naming both, and queues nothing', async () => {
    await openPackFlow(hostWithPack(packJson('99')));
    expect(get(pendingPack)).toBeNull();
    expect(lastToast()).toContain('99');
  });

  it('queues the pack for review when the CAL-ID matches', async () => {
    const id = identifyBin(get(workingBytes)!)!;
    await openPackFlow(hostWithPack(packJson(id.calId)));
    expect(get(pendingPack)).not.toBeNull();
    expect(get(pendingPack)!.rows).toHaveLength(1);
  });

  it('reports a malformed pack instead of throwing', async () => {
    await openPackFlow(hostWithPack('{oops'));
    expect(get(pendingPack)).toBeNull();
    expect(lastToast()).toMatch(/JSON|pack/i);
  });

  it('does nothing when the user cancels the picker', async () => {
    const h = new FakeHost(); // no openAnswers -> resolves null
    await openPackFlow(h);
    expect(get(pendingPack)).toBeNull();
  });

  it('drops a queued pack when a different bin is loaded', async () => {
    const id = identifyBin(get(workingBytes)!)!;
    await openPackFlow(hostWithPack(packJson(id.calId)));
    expect(get(pendingPack)).not.toBeNull();
    // A pack reviewed against one image must never survive into another.
    a.setBin(createBinImage(tuneWithId('12'), 'other.bin'));
    expect(get(pendingPack)).toBeNull();
  });
});

describe('exportPackFlow', () => {
  beforeEach(seed);

  const map: MapDef = {
    id: 'm1',
    name: 'M',
    address: 0x1200,
    rows: 1,
    cols: 2,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major',
    provenance: 'manual',
  };

  it('writes a pack carrying the edited table, with the baseline from the ORIGINAL bytes', async () => {
    expect(a.addImportedMaps([map]).added).toBe(1);
    const before = get(workingBytes)![0x1200]!;
    expect(a.editCell(map, 0, 0, before ^ 0xff).ok).toBe(true);

    const h = new FakeHost();
    h.saveAnswers = ['/out.binpack.json'];
    await exportPackFlow(h);

    const parsed = parsePack(h.files.get('/out.binpack.json') as string);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.tables).toHaveLength(1);
    expect(parsed.value.tables[0]!.values[0]![0]).toBe(before ^ 0xff);
    expect(parsed.value.tables[0]!.baseline[0]![0]).toBe(before);
  });

  it('labels the pack with the id read from the bin, not one typed in', async () => {
    expect(a.addImportedMaps([map]).added).toBe(1);
    const before = get(workingBytes)![0x1200]!;
    a.editCell(map, 0, 0, before ^ 0xff);

    const h = new FakeHost();
    h.saveAnswers = ['/out.binpack.json'];
    await exportPackFlow(h);

    const parsed = parsePack(h.files.get('/out.binpack.json') as string);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.source).toMatchObject(identifyBin(get(workingBytes)!)!);
  });

  it('exports only the tables the journal touched, not every confirmed map', async () => {
    const other: MapDef = { ...map, id: 'm2', name: 'Untouched', address: 0x1300 };
    expect(a.addImportedMaps([map, other]).added).toBe(2);
    const before = get(workingBytes)![0x1200]!;
    a.editCell(map, 0, 0, before ^ 0xff);

    const h = new FakeHost();
    h.saveAnswers = ['/out.binpack.json'];
    await exportPackFlow(h);

    const parsed = parsePack(h.files.get('/out.binpack.json') as string);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.tables.map((t) => t.name)).toEqual(['M']);
  });

  it('refuses to export when nothing has been edited', async () => {
    const h = new FakeHost();
    h.saveAnswers = ['/out.binpack.json'];
    await exportPackFlow(h);
    expect(lastToast()).toMatch(/no edited tables|nothing/i);
    expect(h.files.has('/out.binpack.json')).toBe(false);
  });

  it('refuses to export from a bin whose calibration id cannot be read', async () => {
    // Unlabelled is not a guess: a pack with no verified id could be applied to
    // anything, which is exactly what the CAL-ID gate exists to stop.
    a.resetStores();
    a.setBin(createBinImage(ms41TuneImage(), 'anon.bin'));
    expect(a.addImportedMaps([map]).added).toBe(1);
    const before = get(workingBytes)![0x1200]!;
    a.editCell(map, 0, 0, before ^ 0xff);

    const h = new FakeHost();
    h.saveAnswers = ['/out.binpack.json'];
    await exportPackFlow(h);
    expect(lastToast()).toMatch(/calibration id/i);
    expect(h.files.size).toBe(0);
  });

  it('writes nothing when the user cancels the save dialog', async () => {
    expect(a.addImportedMaps([map]).added).toBe(1);
    const before = get(workingBytes)![0x1200]!;
    a.editCell(map, 0, 0, before ^ 0xff);

    const h = new FakeHost(); // no saveAnswers -> resolves null
    await exportPackFlow(h);
    expect(h.files.size).toBe(0);
  });
});
