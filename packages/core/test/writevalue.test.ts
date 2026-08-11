import { describe, expect, it } from 'vitest';
import type { ValueFormat } from '../src/index.js';
import { readValue, writeValue } from '../src/index.js';

const FORMATS: ValueFormat[] = [
  { width: 1, signed: false, endianness: 'little' },
  { width: 1, signed: true, endianness: 'little' },
  { width: 2, signed: false, endianness: 'little' },
  { width: 2, signed: false, endianness: 'big' },
  { width: 2, signed: true, endianness: 'big' },
  { width: 4, signed: false, endianness: 'little' },
  { width: 4, signed: true, endianness: 'big' },
];

describe('writeValue', () => {
  it('round-trips through readValue for every width, sign and endianness', () => {
    for (const f of FORMATS) {
      const d = new Uint8Array(16);
      const v = f.signed ? -3 : 5;
      writeValue(d, 4, f, v);
      expect(readValue(d, 4, f), JSON.stringify(f)).toBe(v);
    }
  });

  it('round-trips a float cell', () => {
    const f: ValueFormat = { width: 4, signed: true, endianness: 'big', float: true };
    const d = new Uint8Array(8);
    writeValue(d, 0, f, 1.5);
    expect(readValue(d, 0, f)).toBe(1.5);
  });

  it('writes ONLY the cell it was given', () => {
    const d = new Uint8Array(8).fill(0xaa);
    writeValue(d, 2, { width: 2, signed: false, endianness: 'big' }, 0x1234);
    expect([...d]).toEqual([0xaa, 0xaa, 0x12, 0x34, 0xaa, 0xaa, 0xaa, 0xaa]);
  });

  it('throws rather than truncating when the cell runs past the buffer', () => {
    const d = new Uint8Array(4);
    expect(() => writeValue(d, 3, { width: 2, signed: false, endianness: 'big' }, 1)).toThrow(RangeError);
    expect(() => writeValue(d, -1, { width: 1, signed: false, endianness: 'big' }, 1)).toThrow(RangeError);
  });
});
