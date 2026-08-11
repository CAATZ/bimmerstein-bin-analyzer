import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { checksumReport } from '../src/store/stores.js';
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
