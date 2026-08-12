import { describe, expect, it } from 'vitest';
import { MemorySessionStore, bufferFor, type OpenBin } from '../src/session.js';

function entry(id: string, size = 16): OpenBin {
  const buf = new Uint8Array(size);
  return {
    binId: id, sha256: id, name: `${id}.bin`, path: `C:/bins/${id}.bin`,
    size, isFullRead: false, bytes: buf, originalBytes: buf, contentSha256: id, changedBytes: 0,
  };
}

describe('SessionStore is asynchronous', () => {
  /**
   * The Phase-2 seam: a live-session implementation proxies to another process,
   * so every method is a round trip. Asserted on the SHAPE, not via `await` —
   * awaiting a plain value is legal and would pass against a sync store.
   */
  it('every method returns a Promise', async () => {
    const s = new MemorySessionStore(4);
    const calls: Array<[string, unknown]> = [
      ['open', s.open(entry('a'))],
      ['get', s.get('a')],
      ['list', s.list()],
      ['setScan', s.setScan('a', { configVersion: 'v1', result: { regions: [], potentialMaps: [] }, durationMs: 1 })],
      ['setImported', s.setImported('a', { romId: 'R', maps: [], warnings: [], frameApplied: 'none' })],
      ['setDetectedAxes', s.setDetectedAxes('a', [])],
      ['evictedPath', s.evictedPath('a')],
    ];
    for (const [name, returned] of calls) {
      expect(returned, `${name}() must return a Promise`).toBeInstanceOf(Promise);
    }
    await Promise.all(calls.map(([, r]) => r));
  });
});

describe('MemorySessionStore', () => {
  it('opens a bin and returns it by id', async () => {
    const s = new MemorySessionStore(4);
    const r = await s.open(entry('a'));
    expect(r.alreadyOpen).toBe(false);
    expect(r.evicted).toEqual([]);
    expect((await s.get('a'))?.name).toBe('a.bin');
  });

  it('is idempotent: re-opening the same id keeps the FIRST entry', async () => {
    const s = new MemorySessionStore(4);
    await s.open(entry('a'));
    const again = await s.open({ ...entry('a'), path: 'C:/elsewhere/a.bin' });
    expect(again.alreadyOpen).toBe(true);
    expect(again.entry.path).toBe('C:/bins/a.bin');
    expect(await s.list()).toHaveLength(1);
  });

  it('lists most-recently-used first', async () => {
    const s = new MemorySessionStore(4);
    await s.open(entry('a'));
    await s.open(entry('b'));
    expect((await s.list()).map((e) => e.binId)).toEqual(['b', 'a']);
    await s.get('a');
    expect((await s.list()).map((e) => e.binId)).toEqual(['a', 'b']);
  });

  it('evicts the least-recently-used past the bound', async () => {
    const s = new MemorySessionStore(2);
    await s.open(entry('a'));
    await s.open(entry('b'));
    const r = await s.open(entry('c'));
    expect(r.evicted.map((e) => e.binId)).toEqual(['a']);
    expect(await s.get('a')).toBeUndefined();
    expect((await s.list()).map((e) => e.binId)).toEqual(['c', 'b']);
  });

  it('a get() refreshes recency and protects from the next eviction', async () => {
    const s = new MemorySessionStore(2);
    await s.open(entry('a'));
    await s.open(entry('b'));
    await s.get('a');
    const r = await s.open(entry('c'));
    expect(r.evicted.map((e) => e.binId)).toEqual(['b']);
    expect((await s.get('a'))?.binId).toBe('a');
  });

  it('remembers an evicted path so an unknown-id error can help', async () => {
    const s = new MemorySessionStore(1);
    await s.open(entry('a'));
    await s.open(entry('b'));
    expect(await s.evictedPath('a')).toBe('C:/bins/a.bin');
    expect(await s.evictedPath('zz')).toBeUndefined();
  });

  it('attaches scan, imported defs and detected axes to a resident entry', async () => {
    const s = new MemorySessionStore(4);
    await s.open(entry('a'));
    await s.setScan('a', { configVersion: 'v1', result: { regions: [], potentialMaps: [] }, durationMs: 12 });
    await s.setImported('a', { romId: 'R', maps: [], warnings: [], frameApplied: 'none' });
    await s.setDetectedAxes('a', []);
    const e = (await s.get('a'))!;
    expect(e.scan?.durationMs).toBe(12);
    expect(e.imported?.romId).toBe('R');
    expect(e.detectedAxes).toEqual([]);
  });

  it('ignores mutators for an unknown id instead of throwing', async () => {
    const s = new MemorySessionStore(4);
    await expect(
      s.setScan('nope', { configVersion: 'v1', result: { regions: [], potentialMaps: [] }, durationMs: 0 })
    ).resolves.toBeUndefined();
  });
});

describe('OpenBin buffers', () => {
  const twoBuffer = (): OpenBin => ({
    binId: 'aa', sha256: 'aa', name: 'x.bin', path: 'C:/x.bin', size: 4,
    isFullRead: false,
    bytes: Uint8Array.of(9, 9, 9, 9),
    originalBytes: Uint8Array.of(1, 2, 3, 4),
    contentSha256: 'bb',
    changedBytes: 4,
  });

  it('bufferFor returns the working buffer by default and the original on demand', () => {
    const e = twoBuffer();
    expect(bufferFor(e, 'working')).toBe(e.bytes);
    expect(bufferFor(e, 'original')).toBe(e.originalBytes);
  });
});
