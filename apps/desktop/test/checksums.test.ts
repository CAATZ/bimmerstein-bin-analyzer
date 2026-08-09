import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { CAL_MAGIC, crc16 } from '@binanalyzer/families';
import { checksumReport } from '../src/store/stores.js';
import { runChecksumVerify, setChecksumReport } from '../src/store/actions.js';

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

/**
 * A 24 KB (TUNE_SIZE) MS41-shaped image with a single valid cal entry, built
 * locally the same way packages/families/test/fixture.ts's ms41Image(TUNE)
 * does — but via the @binanalyzer/families package entry point only, never
 * by importing that test helper directly (it is not a public entry point).
 */
function ms41TuneImage(): Uint8Array {
  const size = 24 * 1024;
  const d = new Uint8Array(size);
  for (let i = 0; i < size; i++) d[i] = (i * 7) % 251;
  const start = 0x1000;
  d.set(CAL_MAGIC, start);
  d[start + 0x0e] = 0x12; // init BE hi
  d[start + 0x0f] = 0x34; // init BE lo
  d[start + 0x50] = 0xff; // terminator
  d[start + 0x51] = 0xff;
  const calc = crc16(d.subarray(start, start + 0x4e), 0x1234);
  d[start + 0x4e] = calc & 0xff;
  d[start + 0x4f] = (calc >>> 8) & 0xff;
  return d;
}

describe('runChecksumVerify', () => {
  it('sets a report when a family module recognises the image', () => {
    setChecksumReport(undefined);
    runChecksumVerify(ms41TuneImage());
    const r = get(checksumReport);
    expect(r).not.toBeUndefined();
    expect(r?.familyId).toBe('ms41');
    expect(r?.applies).toBe(true);
  });

  it('sets undefined when no family module recognises the image', () => {
    setChecksumReport({
      familyId: 'ms41', applies: true, blocks: [], valid: true, skipped: [], notes: [],
    });
    runChecksumVerify(new Uint8Array(64)); // too small for any known family shape
    expect(get(checksumReport)).toBeUndefined();
  });
});
