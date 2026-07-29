import { describe, expect, it } from 'vitest';
import { createBinImage } from '../src/bin-image.js';

describe('createBinImage', () => {
  it('computes sha256 (NIST "abc" vector) and size', () => {
    const img = createBinImage(new Uint8Array([0x61, 0x62, 0x63]), 'abc.bin');
    expect(img.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(img.size).toBe(3);
    expect(img.name).toBe('abc.bin');
  });
});
