import { describe, expect, it } from 'vitest';
import { readValue } from '../src/codec.js';
import type { ValueFormat } from '../src/types.js';

const u8: ValueFormat = { width: 1, signed: false, endianness: 'big' };
const i8: ValueFormat = { width: 1, signed: true, endianness: 'big' };
const u16be: ValueFormat = { width: 2, signed: false, endianness: 'big' };
const u16le: ValueFormat = { width: 2, signed: false, endianness: 'little' };
const i16be: ValueFormat = { width: 2, signed: true, endianness: 'big' };
const u32le: ValueFormat = { width: 4, signed: false, endianness: 'little' };
const f32le: ValueFormat = { width: 4, signed: false, endianness: 'little', float: true };

describe('readValue', () => {
  const bytes = new Uint8Array([0x12, 0x34, 0xff, 0xfe, 0x00, 0x00, 0x80, 0x3f]);
  it('u8/i8', () => {
    expect(readValue(bytes, 2, u8)).toBe(0xff);
    expect(readValue(bytes, 2, i8)).toBe(-1);
  });
  it('u16 both endiannesses', () => {
    expect(readValue(bytes, 0, u16be)).toBe(0x1234);
    expect(readValue(bytes, 0, u16le)).toBe(0x3412);
  });
  it('i16', () => {
    expect(readValue(bytes, 2, i16be)).toBe(-2);
  });
  it('u32', () => {
    expect(readValue(bytes, 0, u32le)).toBe(4278137874);
  });
  it('f32 (1.0 LE)', () => {
    expect(readValue(bytes, 4, f32le)).toBe(1.0);
  });
  it('throws RangeError out of bounds', () => {
    expect(() => readValue(bytes, 7, u16be)).toThrow(RangeError);
    expect(() => readValue(bytes, -1, u8)).toThrow(RangeError);
  });
});
