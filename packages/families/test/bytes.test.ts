import { describe, expect, it } from 'vitest';
import { be16, trimEnd, u16le } from '../src/bytes.js';

describe('byte helpers', () => {
  it('reads little- and big-endian u16', () => {
    const d = new Uint8Array([0x34, 0x12, 0xab, 0xcd]);
    expect(u16le(d, 0)).toBe(0x1234);
    expect(be16(d, 2)).toBe(0xabcd);
  });

  it('trimEnd scans DOWN past erased 0xFF and returns the first kept index', () => {
    // Erased flash tails are excluded from the CRC. Index 3 is the last
    // non-0xFF byte, so the exclusive end is 4.
    const d = new Uint8Array([1, 2, 3, 4, 0xff, 0xff, 0xff]);
    expect(trimEnd(d, 6)).toBe(4);
  });

  it('trimEnd returns the anchor + 1 when the anchor byte is already kept', () => {
    const d = new Uint8Array([1, 2, 3]);
    expect(trimEnd(d, 2)).toBe(3);
  });

  it('trimEnd yields 1 for an all-0xFF buffer rather than underflowing', () => {
    expect(trimEnd(new Uint8Array([0xff, 0xff, 0xff]), 2)).toBe(1);
  });
});
