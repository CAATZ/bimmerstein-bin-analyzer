import { describe, expect, it } from 'vitest';
import { formatPhysical, toPhysical } from '../src/scaling.js';

describe('scaling', () => {
  it('affine physical = raw*factor + offset', () => {
    expect(toPhysical(100, { factor: 0.25, offset: -48, units: '°C', digits: 1 })).toBe(-23);
  });
  it('rawExpression falls back to raw (never mis-scale)', () => {
    expect(toPhysical(100, { factor: 0.25, offset: 0, units: '', digits: 0, rawExpression: 'x**2' })).toBe(100);
  });
  it('formatPhysical uses digits', () => {
    expect(formatPhysical(3, { factor: 1 / 3, offset: 0, units: '', digits: 2 })).toBe('1.00');
    expect(formatPhysical(3, { factor: 1, offset: 0, units: '', digits: 0 })).toBe('3');
  });
});
