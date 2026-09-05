import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import { saToFo } from '../src/family/ms41/frame.js';
import { readU16SA, readU8SA, validateAxisPtr } from '../src/family/ms41/header.js';
import { detectMs41Tables } from '../src/family/ms41/analyzer.js';

/** SA-addressed byte plants into a cal-window-capable buffer. */
function calImage(): Uint8Array {
  return new Uint8Array(0x18000);
}
function putSA(bytes: Uint8Array, sa: number, vals: number[]): void {
  for (let i = 0; i < vals.length; i++) bytes[saToFo(sa + i)] = vals[i]!;
}

describe('SA-frame reads', () => {
  it('reads u8 and u16 LE through the frame mapping', () => {
    const bytes = calImage();
    putSA(bytes, 0x100, [0x34, 0x12]);
    expect(readU8SA(bytes, 0x100)).toBe(0x34);
    expect(readU16SA(bytes, 0x100)).toBe(0x1234);
  });
});

describe('validateAxisPtr', () => {
  it('uses the adjacent axis boundary to disambiguate a word axis with a monotone byte prefix', () => {
    const bytes = calImage();
    putSA(bytes, 0x100, [4, 0, 16, 18, 24, 35, 48, 52, 80, 69]);
    putSA(bytes, 0x10a, [4, 0, 100, 0, 200, 0, 44, 1, 144, 1]);
    putSA(bytes, 0x3fc, [0, 1, 10, 1]);
    putSA(bytes, 0x400, Array.from({ length: 16 }, (_, i) => 30 + i));
    const tables = detectMs41Tables(bytes, [{ sa: 0x400, fo: saToFo(0x400), w: 1 }], [], DEFAULT_SCAN_CONFIG);
    expect(tables[0]?.xAxis).toEqual({ address: saToFo(0x102), count: 4,
      format: { width: 2, signed: false, endianness: 'little' } });
    expect(tables[0]?.yAxis?.address).toBe(saToFo(0x10c));
  });

  it('validates a u8 count-prefixed monotone axis', () => {
    const bytes = calImage();
    putSA(bytes, 0x100, [6, 10, 20, 30, 40, 50, 60]);
    expect(validateAxisPtr(bytes, 0x100, DEFAULT_SCAN_CONFIG)).toEqual({
      dataSA: 0x101,
      count: 6,
      width: 1,
      kind: 'strict',
      strictLen: 6,
    });
  });

  it('validates a u16 count-prefixed monotone axis when the u8 reading fails', () => {
    const bytes = calImage();
    // count 8 as u16 LE, cells 300..1000 step 100 as u16 LE — the u8 reading
    // of the same bytes is non-monotone (0x00,0x2c,0x01,0x90,…), so width 2 wins
    const vals = [8, 0];
    for (const v of [300, 400, 500, 600, 700, 800, 900, 1000]) vals.push(v & 0xff, v >> 8);
    putSA(bytes, 0x200, vals);
    expect(validateAxisPtr(bytes, 0x200, DEFAULT_SCAN_CONFIG)).toEqual({
      dataSA: 0x202,
      count: 8,
      width: 2,
      kind: 'strict',
      strictLen: 8,
    });
  });

  it('accepts descending runs (direction-agnostic, strictly monotone)', () => {
    const bytes = calImage();
    putSA(bytes, 0x300, [4, 90, 60, 30, 10]);
    expect(validateAxisPtr(bytes, 0x300, DEFAULT_SCAN_CONFIG)).toEqual({
      dataSA: 0x301,
      count: 4,
      width: 1,
      kind: 'strict',
      strictLen: 4,
    });
  });

  it('rejects plateaus, out-of-range counts, out-of-range pointers, and cal overflow', () => {
    const bytes = calImage();
    putSA(bytes, 0x400, [4, 10, 20, 20, 30]); // plateau
    expect(validateAxisPtr(bytes, 0x400, DEFAULT_SCAN_CONFIG)).toBeUndefined();
    putSA(bytes, 0x500, [3, 0, 10, 20, 30]); // count 3 < minCount 4 (u8 and u16 readings)
    expect(validateAxisPtr(bytes, 0x500, DEFAULT_SCAN_CONFIG)).toBeUndefined();
    putSA(bytes, 0x600, [65, 0]); // count 65 > maxCount 64 (u8 and u16 readings)
    expect(validateAxisPtr(bytes, 0x600, DEFAULT_SCAN_CONFIG)).toBeUndefined();
    expect(validateAxisPtr(bytes, 3, DEFAULT_SCAN_CONFIG)).toBeUndefined(); // ptr < MS41_CAL_SA_MIN
    expect(validateAxisPtr(bytes, 0x5ffc, DEFAULT_SCAN_CONFIG)).toBeUndefined(); // ptr > 0x5ffb
    putSA(bytes, 0x5fe0, [40, 0]); // run would end at 0x6009/0x6032 > 0x6000
    expect(validateAxisPtr(bytes, 0x5fe0, DEFAULT_SCAN_CONFIG)).toBeUndefined();
  });

  it('rejects runs crossing the SA 0x4000 frame seam (file-discontiguous)', () => {
    const bytes = calImage();
    // count 32, cells SA 0x3ff1..0x4010: per-SA monotone, but file-split
    // across fo 0x17fff → 0x10000 — downstream file-linear reads would be wrong
    putSA(bytes, 0x3ff0, [32, ...Array.from({ length: 32 }, (_, i) => i + 1)]);
    expect(validateAxisPtr(bytes, 0x3ff0, DEFAULT_SCAN_CONFIG)).toBeUndefined();
  });
});

describe('validateAxisPtr — kind-aware options (v2.1)', () => {
  it('accepts a plateau run when relaxed (strict prefix + constant tail; count includes the tail)', () => {
    const bytes = calImage();
    putSA(bytes, 0x700, [8, 10, 20, 30, 40, 50, 50, 50, 50]);
    expect(validateAxisPtr(bytes, 0x700, DEFAULT_SCAN_CONFIG)).toBeUndefined(); // strict default
    expect(validateAxisPtr(bytes, 0x700, DEFAULT_SCAN_CONFIG, { relaxed: true })).toEqual({
      dataSA: 0x701,
      count: 8,
      width: 1,
      kind: 'plateau',
      strictLen: 5,
    });
  });

  it('accepts a dead (all-equal) run when relaxed', () => {
    const bytes = calImage();
    putSA(bytes, 0x720, [4, 7, 7, 7, 7]);
    expect(validateAxisPtr(bytes, 0x720, DEFAULT_SCAN_CONFIG)).toBeUndefined();
    expect(validateAxisPtr(bytes, 0x720, DEFAULT_SCAN_CONFIG, { relaxed: true })).toEqual({
      dataSA: 0x721,
      count: 4,
      width: 1,
      kind: 'dead',
      strictLen: 1,
    });
  });

  it('rejects a broken tail (zero delta then movement) even when relaxed', () => {
    const bytes = calImage();
    putSA(bytes, 0x740, [5, 10, 20, 20, 30, 40]);
    expect(validateAxisPtr(bytes, 0x740, DEFAULT_SCAN_CONFIG, { relaxed: true })).toBeUndefined();
  });

  it('rejects a direction flip even when relaxed', () => {
    const bytes = calImage();
    putSA(bytes, 0x780, [4, 10, 30, 20, 40]);
    expect(validateAxisPtr(bytes, 0x780, DEFAULT_SCAN_CONFIG, { relaxed: true })).toBeUndefined();
  });

  it('honors a minCount override (the Class A 3-count-axis pattern)', () => {
    const bytes = calImage();
    putSA(bytes, 0x760, [3, 10, 20, 30]);
    expect(validateAxisPtr(bytes, 0x760, DEFAULT_SCAN_CONFIG)).toBeUndefined(); // minCount 4
    expect(validateAxisPtr(bytes, 0x760, DEFAULT_SCAN_CONFIG, { minCount: 2 })).toEqual({
      dataSA: 0x761,
      count: 3,
      width: 1,
      kind: 'strict',
      strictLen: 3,
    });
  });
});
