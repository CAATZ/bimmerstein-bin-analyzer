import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBinImage } from '@binanalyzer/core';
import { ms41TuneImage } from './ms41-image.js';
import * as a from '../src/store/actions.js';
import { bin, checksumReport, editJournal, workingBytes } from '../src/store/stores.js';

const byteMap = (id: string, address: number) => ({
  id, name: id, address, rows: 1, cols: 1,
  format: { width: 1 as const, signed: false, endianness: 'little' as const },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major' as const, provenance: 'manual' as const,
});

/** Load an image the MS41 module recognises, then break a covered byte. */
function loadedAndEdited(): void {
  a.setBin(createBinImage(ms41TuneImage(), 'tune.bin'));
  a.runChecksumVerify();
  expect(get(checksumReport)?.valid).toBe(true);
  a.editCell(byteMap('m', 0x1010), 0, 0, 0x5a); // inside cal coverage
  expect(get(checksumReport)?.valid).toBe(false);
}

beforeEach(() => a.resetStores());

describe('correctForSave', () => {
  it('returns null with no bin loaded', () => {
    expect(a.correctForSave()).toBeNull();
  });

  it('MUTATES NOTHING — the working buffer and journal are untouched', () => {
    loadedAndEdited();
    const before = Uint8Array.from(get(workingBytes)!);
    const journalBefore = new Map(get(editJournal));
    const c = a.correctForSave()!;
    expect(get(workingBytes)!).toEqual(before);
    expect(get(editJournal)).toEqual(journalBefore);
    expect(c.bytes).not.toBe(get(workingBytes)); // a NEW buffer
    expect(c.changed.length).toBeGreaterThan(0);
  });

  it('reports the corrected image as valid, and records the pre-correction edits', () => {
    loadedAndEdited();
    const c = a.correctForSave()!;
    expect(c.report?.applies).toBe(true);
    expect(c.report?.valid).toBe(true);
    expect(c.editedOffsets).toEqual([0x1010]);
  });

  it('with no family module: bytes pass through and report is undefined', () => {
    a.setBin(createBinImage(Uint8Array.from({ length: 64 }, (_, i) => i), 'dump.bin'));
    a.runChecksumVerify();
    const c = a.correctForSave()!;
    expect(c.report).toBeUndefined();
    expect(c.changed).toEqual([]);
    expect([...c.bytes]).toEqual([...get(workingBytes)!]);
  });

  it('never changes the image size', () => {
    loadedAndEdited();
    expect(a.correctForSave()!.bytes.length).toBe(get(bin)!.size);
  });
});

describe('applySaveCorrection', () => {
  it('lands the corrected bytes in the working buffer and re-validates the verdict', () => {
    loadedAndEdited();
    const c = a.correctForSave()!;
    a.applySaveCorrection(c.changed);
    expect([...get(workingBytes)!]).toEqual([...c.bytes]);
    expect(get(checksumReport)?.valid).toBe(true);
  });

  it('is ONE undo step, and undoing restores both the buffer and the journal', () => {
    loadedAndEdited();
    const beforeBytes = Uint8Array.from(get(workingBytes)!);
    const beforeKeys = [...get(editJournal).keys()].sort((x, y) => x - y);
    const c = a.correctForSave()!;
    expect(c.changed.length).toBeGreaterThan(1); // a 16-bit checksum: proves ONE step ≠ one byte
    a.applySaveCorrection(c.changed);
    expect(a.undo()).toBe(true);
    expect([...get(workingBytes)!]).toEqual([...beforeBytes]);
    expect([...get(editJournal).keys()].sort((x, y) => x - y)).toEqual(beforeKeys);
    expect(get(checksumReport)?.valid).toBe(false); // the verdict follows the bytes back
  });

  it('journals the corrected bytes against the file as opened, so they show in the diff', () => {
    loadedAndEdited();
    const c = a.correctForSave()!;
    a.applySaveCorrection(c.changed);
    for (const ch of c.changed) {
      // Every corrected byte either differs from the original (journalled) or
      // returned to it (deleted) — never a stale entry claiming the wrong value.
      const entry = get(editJournal).get(ch.offset);
      if (entry !== undefined) expect(entry.current).toBe(ch.to);
      else expect(get(bin)!.bytes[ch.offset]).toBe(ch.to);
    }
    expect(get(editJournal).has(0x1010)).toBe(true); // the user's own edit is still there
  });
});
