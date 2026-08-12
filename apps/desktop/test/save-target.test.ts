import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBinImage, sha256Hex } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { lastSave, saveTarget, workingBytes } from '../src/store/stores.js';

const BYTES = Uint8Array.from({ length: 64 }, (_, i) => i);
const image = (): ReturnType<typeof createBinImage> => createBinImage(BYTES, 'dump.bin');

/** A 1x1 raw byte map — `editCell` is the only correct way to dirty the buffer,
 *  because it is what maintains the journal the dirty check reads. */
const byteMap = {
  id: 'm', name: 'm', address: 0, rows: 1, cols: 1,
  format: { width: 1 as const, signed: false, endianness: 'little' as const },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major' as const, provenance: 'manual' as const,
};

beforeEach(() => a.resetStores());

describe('saveTarget', () => {
  const target = { path: 'C:\\out\\tuned.bin', name: 'tuned.bin', sha256: 'abc', size: 64 };

  it('starts null and round-trips', () => {
    expect(get(saveTarget)).toBeNull();
    a.setSaveTarget(target);
    expect(get(saveTarget)).toEqual(target);
  });

  it('is cleared by setBin, applyProject and resetStores — a save target belongs to ONE loaded bin', () => {
    for (const clear of [
      (): void => a.setBin(image()),
      (): void => void a.applyProject(image(), {
        schemaVersion: 2,
        bin: { name: 'dump.bin', sha256: image().sha256, size: 64 },
        valueDefaults: { width: 1, signed: false, endianness: 'little' },
        maps: [],
        potentialMaps: [],
      }),
      (): void => a.resetStores(),
    ]) {
      a.setSaveTarget(target);
      a.setLastSave({ ok: false, path: null, reason: 'x' });
      clear();
      expect(get(saveTarget)).toBeNull();
      expect(get(lastSave)).toBeNull();
    }
  });
});

describe('isDirty', () => {
  it('is false with no bin and with an untouched bin', () => {
    expect(a.isDirty()).toBe(false);
    a.setBin(image());
    expect(a.isDirty()).toBe(false);
  });

  it('is true once a byte is edited and no save has happened', () => {
    a.setBin(image());
    a.editCell(byteMap, 0, 0, 9);
    expect(a.isDirty()).toBe(true);
  });

  it('is FALSE when the buffer hashes to the recorded save target — undoing back to a saved state is not dirty', () => {
    a.setBin(image());
    a.editCell(byteMap, 0, 0, 9);
    a.setSaveTarget({ path: 'C:\\out\\t.bin', name: 't.bin', sha256: sha256Hex(get(workingBytes)!), size: 64 });
    expect(a.isDirty()).toBe(false);
    a.editCell(byteMap, 0, 0, 11);
    expect(a.isDirty()).toBe(true);
  });
});

describe('projectSnapshot binds to the image as last saved', () => {
  it('uses the opened bin before any save', () => {
    a.setBin(image());
    const s = a.projectSnapshot();
    expect(s.ok && s.value.bin).toEqual({ name: 'dump.bin', sha256: image().sha256, size: 64 });
  });

  it('uses the save target after one', () => {
    a.setBin(image());
    a.setSaveTarget({ path: 'C:\\out\\tuned.bin', name: 'tuned.bin', sha256: 'deadbeef', size: 64 });
    const s = a.projectSnapshot();
    expect(s.ok && s.value.bin).toEqual({ name: 'tuned.bin', sha256: 'deadbeef', size: 64 });
  });
});
