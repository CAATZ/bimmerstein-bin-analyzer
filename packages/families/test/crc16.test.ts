import { describe, expect, it } from 'vitest';
import { crc16 } from '../src/crc16.js';

describe('crc16 (CRC-16/ARC, poly 0xA001)', () => {
  it('matches the published CRC-16/ARC check value', () => {
    // "123456789" with init 0 is the standard check constant for this
    // algorithm — an EXTERNAL validation, not a self-consistent one.
    const ascii = new Uint8Array([...'123456789'].map((c) => c.charCodeAt(0)));
    expect(crc16(ascii, 0x0000)).toBe(0xbb3d);
  });

  it('returns the init value unchanged for an empty buffer', () => {
    expect(crc16(new Uint8Array(0), 0x4711)).toBe(0x4711);
  });

  it('matches reference vectors at the MS41 boot init', () => {
    expect(crc16(new Uint8Array(16), 0x4711)).toBe(0x6ecb);
    expect(crc16(Uint8Array.from({ length: 16 }, (_, i) => i), 0x4711)).toBe(0x79c1);
  });
});
