import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createBinImage } from '@binanalyzer/core';
import { ms41TuneImage } from './ms41-image.js';
import { checksumReport } from '../src/store/stores.js';
import { runChecksumVerify, setBin, setChecksumReport } from '../src/store/actions.js';

describe('checksum report store', () => {
  it('starts empty', () => {
    setChecksumReport(undefined);
    expect(get(checksumReport)).toBeUndefined();
  });

  it('holds a report once set', () => {
    setChecksumReport({
      familyId: 'ms41', applies: true, blocks: [], valid: true, skipped: [], notes: [],
    });
    expect(get(checksumReport)?.valid).toBe(true);
    setChecksumReport(undefined);
  });
});

describe('runChecksumVerify', () => {
  it('sets a report when a family module recognises the image', () => {
    setChecksumReport(undefined);
    setBin(createBinImage(ms41TuneImage(), 'cal.bin'));
    runChecksumVerify();
    const r = get(checksumReport);
    expect(r).not.toBeUndefined();
    expect(r?.familyId).toBe('ms41');
    expect(r?.applies).toBe(true);
  });

  it('sets undefined when no family module recognises the image', () => {
    setBin(createBinImage(new Uint8Array(64), 'too-small.bin')); // too small for any known family shape
    setChecksumReport({
      familyId: 'ms41', applies: true, blocks: [], valid: true, skipped: [], notes: [],
    });
    runChecksumVerify();
    expect(get(checksumReport)).toBeUndefined();
  });
});
