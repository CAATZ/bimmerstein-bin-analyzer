import { describe, expect, it } from 'vitest';
import type { Scaling, ValueFormat } from '../src/index.js';
import { quantise, toPhysical, toRaw } from '../src/index.js';

const u8: ValueFormat = { width: 1, signed: false, endianness: 'little' };
const s16: ValueFormat = { width: 2, signed: true, endianness: 'big' };
const f32: ValueFormat = { width: 4, signed: true, endianness: 'big', float: true };
const scale = (over: Partial<Scaling> = {}): Scaling => ({
  factor: 1, offset: 0, units: '', digits: 2, ...over,
});

describe('toRaw', () => {
  it('is the exact inverse of toPhysical for affine scalings', () => {
    const s = scale({ factor: 0.1, offset: -40 });
    expect(toRaw(toPhysical(200, s), s)).toBeCloseTo(200, 9);
  });

  it('is the identity when the scaling is a non-affine imported expression', () => {
    // toPhysical returns raw unchanged for rawExpression, so its inverse must too.
    const s = scale({ factor: 999, offset: 999, rawExpression: 'x*2+1' });
    expect(toRaw(123, s)).toBe(123);
  });
});

describe('quantise', () => {
  it('stores an exactly-representable value unchanged', () => {
    const s = scale({ factor: 0.1, offset: 0 });
    expect(quantise(14.7, s, u8)).toEqual({
      stored: 147, physical: 14.700000000000001, clamped: false, editable: true,
    });
  });

  it('snaps a non-representable value to the nearest raw and reports what it decodes back to', () => {
    const s = scale({ factor: 0.1, offset: 0 });
    const r = quantise(14.73, s, u8);
    expect(r.stored).toBe(147);
    expect(r.physical).toBeCloseTo(14.7, 9);
    expect(r.clamped).toBe(false);
  });

  it('clamps above the format maximum instead of wrapping', () => {
    const r = quantise(300, scale(), u8);
    expect(r).toMatchObject({ stored: 255, clamped: true, editable: true });
  });

  it('clamps below the format minimum instead of wrapping', () => {
    expect(quantise(-5, scale(), u8)).toMatchObject({ stored: 0, clamped: true });
    expect(quantise(-40000, scale(), s16)).toMatchObject({ stored: -32768, clamped: true });
  });

  it('rounds half away from zero so stepping is symmetric', () => {
    expect(quantise(2.5, scale(), u8).stored).toBe(3);
    expect(quantise(-2.5, scale(), s16).stored).toBe(-3);
  });

  it('does NOT round to an integer for a float cell', () => {
    const r = quantise(14.73, scale(), f32);
    expect(r.stored).toBeCloseTo(14.73, 5);
    expect(r.clamped).toBe(false);
  });

  it('identity scaling makes physical equal raw', () => {
    expect(quantise(200, scale(), u8)).toMatchObject({ stored: 200, physical: 200 });
  });

  it('reports a zero factor as not editable rather than dividing by zero', () => {
    const r = quantise(10, scale({ factor: 0 }), u8);
    expect(r.editable).toBe(false);
    expect(Number.isFinite(r.stored)).toBe(true);
  });

  it('clamps a float cell to the float32 maximum instead of going infinite', () => {
    const r = quantise(1e39, scale(), f32);
    expect(r.stored).toBe(3.4028234663852886e38);
    expect(Number.isFinite(r.stored)).toBe(true);
    expect(r.clamped).toBe(true);
  });

  it('clamps a float cell to the negative float32 limit instead of going infinite', () => {
    const r = quantise(-1e39, scale(), f32);
    expect(r.stored).toBe(-3.4028234663852886e38);
    expect(Number.isFinite(r.stored)).toBe(true);
    expect(r.clamped).toBe(true);
  });

  it('clamps a float cell that overflows via a very small factor', () => {
    const r = quantise(5, scale({ factor: 1e-40 }), f32);
    expect(Number.isFinite(r.stored)).toBe(true);
    expect(r.clamped).toBe(true);
  });

  it('does NOT report ordinary float32 precision loss as clamping', () => {
    const r = quantise(14.73, scale(), f32);
    expect(r.stored).toBeCloseTo(14.73, 5);
    expect(r.clamped).toBe(false);
  });

  it('substitutes a finite value and reports clamped when raw arrives non-finite', () => {
    const r = quantise(Infinity, scale(), f32);
    expect(Number.isFinite(r.stored)).toBe(true);
    expect(r.clamped).toBe(true);
  });
});
