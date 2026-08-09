import { describe, expect, it } from 'vitest';
import { CAL_MAGIC, crc16 } from '@binanalyzer/families';
import { call, errorText, fakeDeps, payload } from './helpers.js';
import { openBinTool } from '../src/tools/index.js';
import { verifyChecksumsTool } from '../src/tools/verify-checksums.js';

/**
 * A 24 KB (TUNE_SIZE) MS41-shaped image with a single valid cal entry, built
 * locally the same way apps/desktop/test/checksums.test.ts's ms41TuneImage()
 * does — via the @binanalyzer/families package entry point only, never by
 * importing packages/families/test/ directly (it is not a public entry point).
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

interface Report {
  familyId: string | null;
  applies: boolean;
  valid: boolean;
  blocks: Array<Record<string, unknown>>;
  skipped: Array<{ id: string; reason: string }>;
  notes: string[];
}

describe('verify_checksums', () => {
  it('errors clearly when the binId is unknown', async () => {
    const deps = fakeDeps();
    const r = await call(verifyChecksumsTool, { binId: 'nope' }, deps);
    expect(r.isError).toBe(true);
    expect(errorText(r)).toContain('nope');
  });

  it('reports applies:false for an image no family module recognises', async () => {
    // An unrecognised family is a FACT about the image, not a tool failure —
    // so this is a normal result, not isError.
    const deps = fakeDeps({ bins: { '/b/x.bin': new Uint8Array(4096) } });
    const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/x.bin' }, deps));
    const r = await call(verifyChecksumsTool, { binId }, deps);
    expect(r.isError).toBeFalsy();
    const rep = payload<Report>(r);
    expect(rep.applies).toBe(false);
    expect(rep.valid).toBe(false);
    expect(rep.blocks).toEqual([]);
  });

  it('returns the real report on the primary success path, for an image a family module recognises', async () => {
    const deps = fakeDeps({ bins: { '/b/ms41.bin': ms41TuneImage() } });
    const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/ms41.bin' }, deps));
    const r = await call(verifyChecksumsTool, { binId }, deps);
    expect(r.isError).toBeFalsy();
    const rep = payload<Report>(r);
    expect(rep.applies).toBe(true);
    expect(rep.familyId).toBe('ms41');
    expect(rep.blocks.length).toBeGreaterThan(0);
    expect(rep.skipped.some((s) => s.id === 'program')).toBe(true);
  });
});
