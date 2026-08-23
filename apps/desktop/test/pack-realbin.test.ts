import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { createBinImage, readValue, type MapDef } from '@binanalyzer/core';
import { identifyBin } from '@binanalyzer/families';
import { parsePack, type MapPack } from '@binanalyzer/formats';
import * as a from '../src/store/actions.js';
import { exportPackFlow, openPackFlow } from '../src/platform/flows.js';
import { classifyPack, packGateError } from '../src/lib/packapply.js';
import { FakeHost } from './flows.test.js';
import { checksumReport, pendingPack, workingBytes } from '../src/store/stores.js';
import { clearUndo } from '../src/store/undo.js';

/**
 * Map packs on REAL firmware.
 *
 * SKIPPED when the firmware is absent, which is how CI runs: real ECU images
 * are never committed (fixtures/README.md).
 */
const fx = (n: string): string => join(import.meta.dirname, '..', '..', '..', 'fixtures', 'ms41', n);
const E36 = fx('E36 M3 Stock Full Read.bin');

/**
 * A DIFFERENT-calibration image (MS41.0, rom 41) for the gate's refusal case.
 * Supplied via env var rather than a hardcoded path: it lives outside the repo,
 * and a committed absolute path would be both machine-specific and personal.
 *   MS41_OTHER_CAL_BIN=/path/to/1429861_fullread.bin pnpm --filter desktop test
 */
const OTHER_CAL = process.env['MS41_OTHER_CAL_BIN'] ?? '';
const HAVE_OTHER = OTHER_CAL !== '' && existsSync(OTHER_CAL);

/** Inside the MS41 full-read cal window: fo(SA) = (0x10000+SA)^0x4000. */
const CAL = 0x1673c;

describe.skipIf(!existsSync(E36))('map packs on real firmware', () => {
  const load = (): void => {
    a.resetStores();
    a.setBin(createBinImage(new Uint8Array(readFileSync(E36)), 'e36.bin'));
    a.runChecksumVerify();
    clearUndo();
  };

  const map: MapDef = {
    id: 'm1',
    name: 'Cal probe',
    address: CAL,
    rows: 1,
    cols: 4,
    format: { width: 1, signed: false, endianness: 'big' },
    scaling: { factor: 0.75, offset: 0, units: '°', digits: 2 },
    orientation: 'row-major',
    provenance: 'manual',
  };

  /**
   * Produce a pack the way the app actually does — through exportPackFlow —
   * so the frame stamping and labelling are under test too. Hand-building the
   * pack here is what let a frame bug through the first time.
   */
  const exportedPack = async (): Promise<string> => {
    const h = new FakeHost();
    h.saveAnswers = ['/out.binpack.json'];
    await exportPackFlow(h);
    return h.files.get('/out.binpack.json') as string;
  };

  const applyThrough = async (json: string): Promise<void> => {
    const h = new FakeHost();
    h.openAnswers = ['/in.binpack.json'];
    h.files.set('/in.binpack.json', json);
    await openPackFlow(h);
  };

  it('reads a calibration id straight out of the image', () => {
    load();
    expect(identifyBin(get(workingBytes)!)).toEqual({ familyId: 'ms41', calId: '12' });
  });

  it('builds a pack from an edit and applies it byte-exactly to another copy', async () => {
    load();
    expect(a.addImportedMaps([map]).added).toBe(1);
    const before = readValue(get(workingBytes)!, CAL, map.format);
    expect(a.editCell(map, 0, 0, (before ^ 0x0f) * 0.75).ok).toBe(true);
    const tuned = readValue(get(workingBytes)!, CAL, map.format);
    expect(tuned).not.toBe(before);

    const json = await exportedPack();
    const parsed = parsePack(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // A full read's offsets must be labelled as such, or the pack cannot be
    // classified against the very image it came from.
    expect(parsed.value.source.addressFrame).toBe('ms41full');

    // Fresh copy of the same image — the recipient.
    load();
    expect(packGateError(parsed.value, identifyBin(get(workingBytes)!))).toBeUndefined();
    await applyThrough(json);

    const queued = get(pendingPack);
    expect(queued).not.toBeNull();
    expect(queued!.rows[0]!.klass).toBe('ready');
    a.applyPackRows(queued!.rows);
    expect(readValue(get(workingBytes)!, CAL, map.format)).toBe(tuned);
  });

  it('leaves every byte outside the pack untouched', async () => {
    load();
    expect(a.addImportedMaps([map]).added).toBe(1);
    const before = readValue(get(workingBytes)!, CAL, map.format);
    a.editCell(map, 0, 0, (before ^ 0x0f) * 0.75);
    const parsed = parsePack(await exportedPack());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const pack: MapPack = parsed.value;

    load();
    const original = Uint8Array.from(get(workingBytes)!);
    const rows = classifyPack({ pack, bytes: get(workingBytes)!, binIsFullRead: true });
    a.applyPackRows(rows);

    const after = get(workingBytes)!;
    const moved: number[] = [];
    for (let i = 0; i < original.length; i++) if (original[i] !== after[i]) moved.push(i);
    // Exactly the one cell the author edited — nothing else in 256 KB.
    expect(moved).toEqual([CAL]);
  });

  it('invalidates the covering checksum, exactly as a hand edit does', async () => {
    load();
    expect(a.addImportedMaps([map]).added).toBe(1);
    const before = readValue(get(workingBytes)!, CAL, map.format);
    a.editCell(map, 0, 0, (before ^ 0x0f) * 0.75);
    const parsed = parsePack(await exportedPack());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const pack: MapPack = parsed.value;

    load();
    const covering = (): { id: string; ok: boolean } | undefined =>
      get(checksumReport)?.blocks.find((b) => b.covers.some((c) => c.start <= CAL && CAL < c.end));
    // Stock firmware: the block covering our cell verifies before we touch it.
    expect(covering()?.ok).toBe(true);

    a.applyPackRows(classifyPack({ pack, bytes: get(workingBytes)!, binIsFullRead: true }));
    // Applying a pack must move the verdict — a silent pass would mean the
    // re-verify never ran, and the user would save a bin with a bad checksum.
    expect(covering()?.ok).toBe(false);
  });

  it.skipIf(!HAVE_OTHER)('REFUSES a pack against a different-calibration image, naming both ids', () => {
    load();
    const packCal = identifyBin(get(workingBytes)!)!.calId;
    const other = identifyBin(new Uint8Array(readFileSync(OTHER_CAL)))!;
    expect(other.calId).not.toBe(packCal);

    const pack: MapPack = {
      schemaVersion: 1,
      source: { familyId: 'ms41', calId: packCal, binSha256: 'a'.repeat(64) },
      title: 't',
      tables: [
        {
          name: 'T',
          address: CAL,
          rows: 1,
          cols: 1,
          orientation: 'row-major',
          format: { width: 1, signed: false, endianness: 'big' },
          scaling: { factor: 1, offset: 0, units: '', digits: 0 },
          values: [[1]],
          baseline: [[0]],
        },
      ],
    };
    const e = packGateError(pack, other)!;
    expect(e).toContain(packCal);
    expect(e).toContain(other.calId);
  });
});
