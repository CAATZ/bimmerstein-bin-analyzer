import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { call, errorText, fakeDeps, payload } from './helpers.js';
import { getMapTool, listMapsTool, openBinTool, scanBinTool } from '../src/tools/index.js';

const SYNTH1 = new Uint8Array(readFileSync(new URL('../../../fixtures/synthetic/synth-1.bin', import.meta.url)));
/** 24 KB — below MS41_MIN_BIN_LEN, so the fo(SA) full-read mapping does not apply. */
const PARTIAL = new Uint8Array(readFileSync(new URL('../../../fixtures/synthetic/synth-partial-201.bin', import.meta.url)));

async function scanned(): Promise<{ deps: ReturnType<typeof fakeDeps>; binId: string }> {
  const deps = fakeDeps({ bins: { '/b/s1.bin': SYNTH1 } });
  const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/s1.bin' }, deps));
  await call(scanBinTool, { binId }, deps);
  return { deps, binId };
}

interface Page {
  total: number;
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  maps: Array<Record<string, unknown>>;
}

describe('list_maps', () => {
  it('pages with a stable total order and reports hasMore', async () => {
    const { deps, binId } = await scanned();
    const p1 = payload<Page>(await call(listMapsTool, { binId, limit: 10 }, deps));
    expect(p1.total).toBe(24);
    expect(p1.returned).toBe(10);
    expect(p1.hasMore).toBe(true);
    const p2 = payload<Page>(await call(listMapsTool, { binId, limit: 10, offset: 10 }, deps));
    const p3 = payload<Page>(await call(listMapsTool, { binId, limit: 10, offset: 20 }, deps));
    expect(p3.returned).toBe(4);
    expect(p3.hasMore).toBe(false);
    const ids = [...p1.maps, ...p2.maps, ...p3.maps].map((m) => m['id']);
    expect(new Set(ids).size).toBe(24);
  });

  it('sorts by confidence descending by default and by address on request', async () => {
    const { deps, binId } = await scanned();
    const conf = payload<Page>(await call(listMapsTool, { binId, limit: 24 }, deps)).maps.map((m) => m['confidence'] as number);
    expect([...conf].sort((a, b) => b - a)).toEqual(conf);
    const addr = payload<Page>(await call(listMapsTool, { binId, limit: 24, sort: 'address' }, deps)).maps.map((m) => m['address'] as number);
    expect([...addr].sort((a, b) => a - b)).toEqual(addr);
  });

  it('filters by kind, address window and confidence floor', async () => {
    const { deps, binId } = await scanned();
    const grids = payload<Page>(await call(listMapsTool, { binId, kind: 'grid', limit: 200 }, deps));
    expect(grids.maps.every((m) => m['kind'] === 'grid')).toBe(true);
    const window = payload<Page>(await call(listMapsTool, { binId, addressMin: 0, addressMax: '0x1000', limit: 200 }, deps));
    expect(window.maps.every((m) => (m['address'] as number) < 0x1000)).toBe(true);
    const floor0 = payload<Page>(await call(listMapsTool, { binId, minConfidence: 0, limit: 200 }, deps));
    expect(floor0.total).toBe(24);
    const floor1 = payload<Page>(await call(listMapsTool, { binId, minConfidence: 1, limit: 200 }, deps));
    expect(floor1.total).toBeLessThanOrEqual(24);
    expect(floor1.maps.every((m) => (m['confidence'] as number) >= 1)).toBe(true);
    expect(errorText(await call(listMapsTool, { binId, minConfidence: 1.5 }, deps))).toContain('between 0 and 1');
  });

  it('filters by a case-insensitive name substring', async () => {
    const { deps, binId } = await scanned();
    const all = payload<Page>(await call(listMapsTool, { binId, limit: 200 }, deps));
    const needle = String(all.maps[0]?.['name'] ?? '').slice(0, 3).toUpperCase();
    const hit = payload<Page>(await call(listMapsTool, { binId, nameContains: needle, limit: 200 }, deps));
    expect(hit.total).toBeGreaterThan(0);
  });

  it('rejects a limit above the cap and an unscanned potential source', async () => {
    const { deps, binId } = await scanned();
    expect(errorText(await call(listMapsTool, { binId, limit: 201 }, deps))).toContain('between 1 and 200');
    const fresh = fakeDeps({ bins: { '/b/s1.bin': SYNTH1 } });
    const { binId: id2 } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/s1.bin' }, fresh));
    expect(errorText(await call(listMapsTool, { binId: id2, source: 'potential' }, fresh))).toContain('scan_bin');
  });
});

describe('get_map', () => {
  it('returns the full MapDef plus decoded axis detail', async () => {
    const { deps, binId } = await scanned();
    const first = payload<Page>(await call(listMapsTool, { binId, limit: 1 }, deps)).maps[0]!;
    const r = payload(await call(getMapTool, { binId, mapId: first['id'] }, deps));
    const map = r['map'] as Record<string, unknown>;
    expect(map['id']).toBe(first['id']);
    expect(r['source']).toBe('potential');
    expect(r['kind']).toBe(first['kind']);
    expect(r['byteLength']).toBe((map['rows'] as number) * (map['cols'] as number) * ((map['format'] as { width: number }).width));
    expect(r['addressEnd']).toBe((map['address'] as number) + (r['byteLength'] as number));
  });

  it('reports SA representability on a bin at or above the full-read threshold', async () => {
    // synth-1 is 0x20000 bytes, i.e. >= MS41_MIN_BIN_LEN (0x18000), so the
    // fo(SA) mapping is the one that applies and the badge is computed.
    const { deps, binId } = await scanned();
    const first = payload<Page>(await call(listMapsTool, { binId, limit: 1 }, deps)).maps[0]!;
    const r = payload(await call(getMapTool, { binId, mapId: first['id'] }, deps));
    expect(typeof r['saRepresentable']).toBe('boolean');
    if (r['saRepresentable'] === true) expect(typeof r['storageAddress']).toBe('number');
    else expect(r).not.toHaveProperty('storageAddress');
  });

  it('omits SA fields below the full-read threshold, where a file offset IS the storageaddress', async () => {
    const deps = fakeDeps({ bins: { '/b/p.bin': PARTIAL } });
    const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/p.bin' }, deps));
    await call(scanBinTool, { binId }, deps);
    const first = payload<Page>(await call(listMapsTool, { binId, limit: 1 }, deps)).maps[0]!;
    const r = payload(await call(getMapTool, { binId, mapId: first['id'] }, deps));
    expect(r).not.toHaveProperty('storageAddress');
    expect(r).not.toHaveProperty('saRepresentable');
  });

  it('errors helpfully on an unknown mapId', async () => {
    const { deps, binId } = await scanned();
    const text = errorText(await call(getMapTool, { binId, mapId: 'no-such-map' }, deps));
    expect(text).toContain('list_maps');
    expect(text).toContain('24');
  });
});
