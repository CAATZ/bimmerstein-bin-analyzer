import { describe, expect, it } from 'vitest';
import { createBinImage, sha256Hex } from '../src/index.js';

describe('sha256Hex', () => {
  it('matches the sha createBinImage records for the same bytes', () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
    expect(sha256Hex(bytes)).toBe(createBinImage(bytes, 'x.bin').sha256);
  });

  it('is lowercase hex of the right length', () => {
    expect(sha256Hex(new Uint8Array(0))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when a single byte differs', () => {
    const a = new Uint8Array(32).fill(7);
    const b = new Uint8Array(32).fill(7);
    b[31] = 8;
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });
});
