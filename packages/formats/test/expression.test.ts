import { describe, expect, it } from 'vitest';
import {
  digitsFromFormat,
  formatFromDigits,
  parseAffineExpression,
  renderAffineExpression,
  renderInverseExpression,
} from '../src/expression.js';

describe('parseAffineExpression', () => {
  // Real expressions from the MS41 def family (ms41-cal-defs scaling catalog).
  it.each([
    ['x', 1, 0],
    ['x*0.0025', 0.0025, 0],
    ['x*.75-48', 0.75, -48],
    ['(x-128)*.375', 0.375, -48],
    ['(x*.375)-23.6', 0.375, -23.6],
    ['x*(1389/65535)', 1389 / 65535, 0],
    ['x*(1389/65535)*4', (1389 / 65535) * 4, 0],
    ['(x+23.6)/.375', 1 / 0.375, 23.6 / 0.375],
    ['x/32', 1 / 32, 0],
    ['x*0.05+8.25', 0.05, 8.25],
    ['(x-32768)*0.02', 0.02, -655.36],
    ['x*-0.375', -0.375, 0],
    ['128', 0, 128], // constant: affine with factor 0
  ])('parses %s', (expr, factor, offset) => {
    const r = parseAffineExpression(expr);
    expect(r).not.toBeNull();
    expect(r!.factor).toBeCloseTo(factor, 9);
    expect(r!.offset).toBeCloseTo(offset, 9);
  });

  it.each([['x*x'], ['1/x'], ['x/0'], ['log(x)'], ['if(x>3,1,0)'], ['BitWise(4,x,2)'], [''], ['x*'], ['(x'], ['x^2']])(
    'rejects non-affine %s',
    (expr) => {
      expect(parseAffineExpression(expr)).toBeNull();
    }
  );
});

describe('render + inverse', () => {
  it('round-trips scientific notation emitted for small and large coefficients', () => {
    for (const [factor, offset] of [[1e-7, -1e-8], [-2.5e-8, 1e21], [0, 1e-9]] as const) {
      expect(parseAffineExpression(renderAffineExpression(factor, offset, 'x'))).toEqual({ factor, offset });
    }
    expect(parseAffineExpression('X*2.5E-3+1E+2')).toEqual({ factor: 0.0025, offset: 100 });
    for (const expr of ['x*1e', 'x*1e+', 'x*1e--2', 'x*1e999']) {
      expect(parseAffineExpression(expr)).toBeNull();
    }
  });

  it('renders canonical forms', () => {
    expect(renderAffineExpression(1, 0, 'x')).toBe('x');
    expect(renderAffineExpression(0.0025, 0, 'x')).toBe('x*0.0025');
    expect(renderAffineExpression(0.75, -48, 'x')).toBe('x*0.75-48');
    expect(renderAffineExpression(1, 12, 'X')).toBe('X+12');
    expect(renderAffineExpression(0, 128, 'x')).toBe('128');
  });
  it('renders the to_byte inverse', () => {
    expect(renderInverseExpression(1, 0, 'x')).toBe('x');
    expect(renderInverseExpression(0.0025, 0, 'x')).toBe('x/0.0025');
    expect(renderInverseExpression(0.75, -48, 'x')).toBe('(x+48)/0.75');
    expect(renderInverseExpression(1, 12, 'x')).toBe('x-12');
    expect(renderInverseExpression(0, 5, 'x')).toBeNull();
  });
  it('round-trips render → parse exactly', () => {
    for (const [f, o] of [[0.0025, 0], [0.375, -48], [1, 0], [1 / 32, 0], [0.05, 8.25]] as const) {
      const r = parseAffineExpression(renderAffineExpression(f, o, 'x'));
      expect(r).toEqual({ factor: f, offset: o });
    }
  });
});

describe('format patterns', () => {
  it.each([
    [undefined, 0],
    ['#', 0],
    ['0', 0],
    ['0.00', 2],
    ['#.##', 2],
    ['0.0', 1],
  ])('digitsFromFormat(%s) === %i', (pattern, digits) => {
    expect(digitsFromFormat(pattern)).toBe(digits);
  });
  it('formatFromDigits round-trips through digitsFromFormat', () => {
    for (const d of [0, 1, 2, 3]) expect(digitsFromFormat(formatFromDigits(d))).toBe(d);
  });
});
