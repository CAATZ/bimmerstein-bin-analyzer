import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import { checksumsFor } from '@binanalyzer/families';
import * as a from '../src/store/actions.js';
import { checksumReport, workingBytes } from '../src/store/stores.js';
import { ms41TuneImage } from './ms41-image.js';

const CAL_START = 0x1000; // where ms41TuneImage plants the table

const map = (address: number): MapDef => ({
  id: 'm1', name: 'M', address, rows: 1, cols: 1,
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major', provenance: 'manual',
});

beforeEach(() => {
  a.resetStores();
  const img = createBinImage(ms41TuneImage(), 'cal.bin');
  a.setBin(img);
  a.runChecksumVerify(img.bytes); // load-time verdict, as flows.ts does
});

describe('checksum verdict after an edit', () => {
  it('starts valid on the synthetic image', () => {
    expect(get(checksumReport)?.valid).toBe(true);
  });

  it('goes invalid when a covered byte is edited, and valid again on revert', () => {
    const off = CAL_START + 0x10; // inside entry 0's covered range
    a.editCell(map(off), 0, 0, 0x5a);
    expect(get(checksumReport)?.valid).toBe(false);
    a.revertAll();
    expect(get(checksumReport)?.valid).toBe(true);
  });

  it('an edit OUTSIDE every covered region leaves the verdict valid', () => {
    a.editCell(map(0x50), 0, 0, 0x5a); // before the cal table
    expect(get(checksumReport)?.valid).toBe(true);
  });
});

/**
 * I4 (final whole-branch review): an edit that breaks the family module's own
 * structural ACTIVATION GATE (not just a checksum) must still leave a report
 * on screen — `applies: false`, not `undefined`. `reverifyChecksums` must use
 * the module resolved at LOAD time rather than re-resolving via
 * `checksumsFor(working)`, which would re-run that same gate against the
 * edited bytes and vanish the chip instead of turning it red.
 */
describe('checksum verdict after an edit that breaks the activation gate (I4)', () => {
  it('corrupting the cal-table magic produces applies:false, not an undefined report', () => {
    a.editCell(map(CAL_START), 0, 0, 0x00); // clobbers CAL_MAGIC's first byte
    const r = get(checksumReport);
    expect(r).toBeDefined();
    expect(r?.applies).toBe(false);
    expect(r?.valid).toBe(false);
    expect(r?.blocks).toEqual([]);
  });

  it('re-verifies with the module resolved at load, not a fresh checksumsFor gate', () => {
    a.editCell(map(CAL_START), 0, 0, 0x00);
    // Sanity: re-RESOLVING against the edited bytes would find no family at
    // all — proving reverifyChecksums does NOT do that, or the report below
    // would be undefined instead of an honest applies:false.
    expect(checksumsFor(get(workingBytes)!)).toBeUndefined();
    expect(get(checksumReport)).toBeDefined();
    expect(get(checksumReport)?.applies).toBe(false);
  });

  it('reverting the edit restores applies:true and a valid verdict', () => {
    a.editCell(map(CAL_START), 0, 0, 0x00);
    expect(get(checksumReport)?.applies).toBe(false);
    a.revertAll();
    expect(get(checksumReport)?.applies).toBe(true);
    expect(get(checksumReport)?.valid).toBe(true);
  });
});
