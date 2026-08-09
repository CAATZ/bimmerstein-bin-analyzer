import { describe, expect, it } from 'vitest';
import { call, errorText, fakeDeps, payload } from './helpers.js';
import { openBinTool } from '../src/tools/index.js';
import { verifyChecksumsTool } from '../src/tools/verify-checksums.js';

interface Report {
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
});
