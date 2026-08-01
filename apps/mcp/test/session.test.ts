import { describe, expect, it } from 'vitest';
import { MemorySessionStore, type OpenBin } from '../src/session.js';

function entry(id: string, size = 16): OpenBin {
  return {
    binId: id, sha256: id, name: `${id}.bin`, path: `C:/bins/${id}.bin`,
    size, isFullRead: false, bytes: new Uint8Array(size),
  };
}

describe('MemorySessionStore', () => {
  it('opens a bin and returns it by id', () => {
    const s = new MemorySessionStore(4);
    const r = s.open(entry('a'));
    expect(r.alreadyOpen).toBe(false);
    expect(r.evicted).toEqual([]);
    expect(s.get('a')?.name).toBe('a.bin');
  });

  it('is idempotent: re-opening the same id keeps the FIRST entry', () => {
    const s = new MemorySessionStore(4);
    s.open(entry('a'));
    const again = s.open({ ...entry('a'), path: 'C:/elsewhere/a.bin' });
    expect(again.alreadyOpen).toBe(true);
    expect(again.entry.path).toBe('C:/bins/a.bin');
    expect(s.list()).toHaveLength(1);
  });

  it('lists most-recently-used first', () => {
    const s = new MemorySessionStore(4);
    s.open(entry('a'));
    s.open(entry('b'));
    expect(s.list().map((e) => e.binId)).toEqual(['b', 'a']);
    s.get('a');
    expect(s.list().map((e) => e.binId)).toEqual(['a', 'b']);
  });

  it('evicts the least-recently-used past the bound', () => {
    const s = new MemorySessionStore(2);
    s.open(entry('a'));
    s.open(entry('b'));
    const r = s.open(entry('c'));
    expect(r.evicted.map((e) => e.binId)).toEqual(['a']);
    expect(s.get('a')).toBeUndefined();
    expect(s.list().map((e) => e.binId)).toEqual(['c', 'b']);
  });

  it('a get() refreshes recency and protects from the next eviction', () => {
    const s = new MemorySessionStore(2);
    s.open(entry('a'));
    s.open(entry('b'));
    s.get('a');
    const r = s.open(entry('c'));
    expect(r.evicted.map((e) => e.binId)).toEqual(['b']);
    expect(s.get('a')?.binId).toBe('a');
  });

  it('remembers an evicted path so an unknown-id error can help', () => {
    const s = new MemorySessionStore(1);
    s.open(entry('a'));
    s.open(entry('b'));
    expect(s.evictedPath('a')).toBe('C:/bins/a.bin');
    expect(s.evictedPath('zz')).toBeUndefined();
  });

  it('attaches scan, imported defs and detected axes to a resident entry', () => {
    const s = new MemorySessionStore(4);
    s.open(entry('a'));
    s.setScan('a', { configVersion: 'v1', result: { regions: [], potentialMaps: [] }, durationMs: 12 });
    s.setImported('a', { romId: 'R', maps: [], warnings: [], frameApplied: 'none' });
    s.setDetectedAxes('a', []);
    const e = s.get('a')!;
    expect(e.scan?.durationMs).toBe(12);
    expect(e.imported?.romId).toBe('R');
    expect(e.detectedAxes).toEqual([]);
  });

  it('ignores mutators for an unknown id instead of throwing', () => {
    const s = new MemorySessionStore(4);
    expect(() => s.setScan('nope', { configVersion: 'v1', result: { regions: [], potentialMaps: [] }, durationMs: 0 })).not.toThrow();
  });
});
