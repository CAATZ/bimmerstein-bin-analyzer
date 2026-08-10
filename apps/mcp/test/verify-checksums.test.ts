import { describe, expect, it } from 'vitest';
import { CAL_MAGIC, crc16 } from '@binanalyzer/families';
import { call, errorText, fakeDeps, payload } from './helpers.js';
import { openBinTool } from '../src/tools/index.js';
import { verifyChecksumsTool } from '../src/tools/verify-checksums.js';

/**
 * A 24 KB MS41-shaped image the checksum module recognises, built from the
 * package's public primitives — never by importing packages/families/test/,
 * which is not an entry point this app may reach across.
 *
 * NOTE — near-identical builders live in `apps/desktop/test/ms41-image.ts` and
 * `packages/families/test/fixture.ts`. Three copies is what package boundaries
 * cost here; keep them in step. They do not drift silently: tightening the
 * activation gate failed all of them in one run.
 *
 * Four entries because the gate rejects a shorter terminating walk — a lone
 * entry is what a magic landing in erased flash produces.
 */
function ms41TuneImage(): Uint8Array {
  const size = 24 * 1024;
  const d = new Uint8Array(size);
  for (let i = 0; i < size; i++) d[i] = (i * 7) % 251;
  const start = 0x1000;
  d.set(CAL_MAGIC, start);
  d[start + 0x0e] = 0x12; // init BE hi
  d[start + 0x0f] = 0x34; // init BE lo
  // Four entries: the activation gate rejects a terminating walk shorter than
  // that, because a lone entry is what a magic landing in erased flash produces.
  // Entry 0's offset word is the magic itself (0x004E); the rest follow at the
  // previous store + 2, and the walk ends on the 0xFFFF terminator.
  const stores = [0x4e, 0x80, 0xb0, 0xe0];
  for (let i = 1; i < stores.length; i++) {
    const at = start + stores[i - 1]! + 2;
    d[at] = stores[i]! & 0xff;
    d[at + 1] = (stores[i]! >>> 8) & 0xff;
  }
  const end = start + stores[stores.length - 1]! + 2;
  d[end] = 0xff;
  d[end + 1] = 0xff;
  let from = start;
  for (const s of stores) {
    const store = start + s;
    const calc = crc16(d.subarray(from, store), 0x1234);
    d[store] = calc & 0xff;
    d[store + 1] = (calc >>> 8) & 0xff;
    from = store + 2;
  }
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
