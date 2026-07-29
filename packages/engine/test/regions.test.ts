import { describe, expect, it } from 'vitest';
import { classifyRegions } from '../src/regions.js';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';

/** Deterministic pseudo-random bytes (LCG) — looks like code (high entropy). */
function codeBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

/** Smooth u16be table-like data: values in a narrow band → low entropy. */
function tableBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n / 2; i++) {
    const v = 3000 + ((i * 7) % 200);
    out[2 * i] = v >> 8;
    out[2 * i + 1] = v & 0xff;
  }
  return out;
}

describe('classifyRegions', () => {
  it('classifies fill as empty, LCG as code, smooth values as data', () => {
    const bytes = new Uint8Array(12288);
    bytes.fill(0xff, 0, 4096);
    bytes.set(codeBytes(4096), 4096);
    bytes.set(tableBytes(4096), 8192);
    const regions = classifyRegions(bytes, DEFAULT_SCAN_CONFIG);
    // coverage and ordering invariants
    expect(regions[0]!.start).toBe(0);
    expect(regions[regions.length - 1]!.end).toBe(bytes.length);
    for (let i = 1; i < regions.length; i++) {
      expect(regions[i]!.start).toBe(regions[i - 1]!.end);
      expect(regions[i]!.kind).not.toBe(regions[i - 1]!.kind);
    }
    // majority-kind checks per third
    const kindAt = (off: number) => regions.find((r) => off >= r.start && off < r.end)!.kind;
    expect(kindAt(2000)).toBe('empty');
    expect(kindAt(6000)).toBe('code');
    expect(kindAt(10000)).toBe('data');
  });
  it('empty input → no regions', () => {
    expect(classifyRegions(new Uint8Array(0), DEFAULT_SCAN_CONFIG)).toEqual([]);
  });
});
