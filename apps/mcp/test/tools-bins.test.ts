import { describe, expect, it } from 'vitest';
import { call, errorText, fakeDeps, payload } from './helpers.js';
import { listBinsTool, openBinTool, TOOLS } from '../src/tools/index.js';

const SMALL = new Uint8Array(64).fill(7);
const FULL = new Uint8Array(0x18000).fill(3);

describe('tool registry', () => {
  it('every registered tool has a unique name, a description and an object schema', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema['type']).toBe('object');
    }
  });
});

describe('open_bin', () => {
  it('returns a sha256 binId and MS41 full-read flag', async () => {
    const deps = fakeDeps({ bins: { '/b/full.bin': FULL } });
    const r = payload(await call(openBinTool, { path: '/b/full.bin' }, deps));
    expect(r['binId']).toMatch(/^[0-9a-f]{64}$/);
    expect(r['binId']).toBe(r['sha256']);
    expect(r['name']).toBe('full.bin');
    expect(r['size']).toBe(0x18000);
    expect(r['isFullRead']).toBe(true);
    expect(r['alreadyOpen']).toBe(false);
    expect(r).not.toHaveProperty('evicted');
  });

  it('flags a partial as not a full read', async () => {
    const deps = fakeDeps({ bins: { '/b/part.bin': SMALL } });
    expect(payload(await call(openBinTool, { path: '/b/part.bin' }, deps))['isFullRead']).toBe(false);
  });

  it('is idempotent: same bytes -> same id, alreadyOpen on the second call', async () => {
    const deps = fakeDeps({ bins: { '/b/a.bin': SMALL, '/b/copy.bin': SMALL } });
    const first = payload(await call(openBinTool, { path: '/b/a.bin' }, deps));
    const second = payload(await call(openBinTool, { path: '/b/copy.bin' }, deps));
    expect(second['binId']).toBe(first['binId']);
    expect(second['alreadyOpen']).toBe(true);
    expect(second['path']).toBe('/b/a.bin');
  });

  it('reports evictions past the LRU bound', async () => {
    const bins: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++) bins[`/b/${i}.bin`] = new Uint8Array(8).fill(i);
    const deps = fakeDeps({ bins });
    let last = payload(await call(openBinTool, { path: '/b/0.bin' }, deps));
    for (let i = 1; i < 5; i++) last = payload(await call(openBinTool, { path: `/b/${i}.bin` }, deps));
    expect((last['evicted'] as string[]).length).toBe(1);
  });

  it('surfaces a read failure verbatim', async () => {
    const deps = fakeDeps({ bins: {} });
    expect(errorText(await call(openBinTool, { path: '/b/nope.bin' }, deps))).toContain('no such file');
  });

  it('rejects a missing path argument', async () => {
    expect(errorText(await call(openBinTool, {}, fakeDeps()))).toContain('"path" is required');
  });
});

describe('list_bins', () => {
  it('lists most-recently-used first with scan/import state', async () => {
    const deps = fakeDeps({ bins: { '/b/a.bin': SMALL, '/b/b.bin': FULL } });
    const a = payload(await call(openBinTool, { path: '/b/a.bin' }, deps));
    await call(openBinTool, { path: '/b/b.bin' }, deps);
    const r = payload<{ bins: Array<Record<string, unknown>>; maxOpenBins: number }>(await call(listBinsTool, {}, deps));
    expect(r.maxOpenBins).toBe(4);
    expect(r.bins).toHaveLength(2);
    expect(r.bins[0]?.['name']).toBe('b.bin');
    expect(r.bins[1]?.['binId']).toBe(a['binId']);
    expect(r.bins[0]?.['scanned']).toBe(false);
    expect(r.bins[0]?.['importedMaps']).toBe(0);
  });

  it('is empty before anything is opened', async () => {
    expect(payload<{ bins: unknown[] }>(await call(listBinsTool, {}, fakeDeps())).bins).toEqual([]);
  });
});
