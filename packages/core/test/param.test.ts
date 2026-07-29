import { describe, expect, it } from 'vitest';
import { isParamShaped } from '../src/param.js';

describe('isParamShaped', () => {
  it('true for a 1×1 map without states', () => {
    expect(isParamShaped({ rows: 1, cols: 1 })).toBe(true);
  });
  it('false when states are present — switches win (the only existing 1×1 golden row is a switch)', () => {
    expect(isParamShaped({ rows: 1, cols: 1, states: [{ name: 'On', data: [1] }] })).toBe(false);
  });
  it('false for any non-1×1 shape (curves, grids, multi-byte switches)', () => {
    expect(isParamShaped({ rows: 16, cols: 1 })).toBe(false);
    expect(isParamShaped({ rows: 1, cols: 12 })).toBe(false);
    expect(isParamShaped({ rows: 16, cols: 12 })).toBe(false);
  });
});
