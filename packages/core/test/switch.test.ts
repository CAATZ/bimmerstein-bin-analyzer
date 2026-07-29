import { describe, expect, it } from 'vitest';
import type { MapDef } from '../src/types.js';
import { isSwitch, matchSwitchState } from '../src/switch.js';

const sw = (address: number, rows: number, states: MapDef['states']): MapDef => ({
  id: `t-0x${address.toString(16)}`,
  name: 'switch',
  address,
  rows,
  cols: 1,
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major',
  provenance: 'imported',
  ...(states !== undefined ? { states } : {}),
});

describe('isSwitch', () => {
  it('true iff states present', () => {
    expect(isSwitch(sw(0, 1, [{ name: 'On', data: [1] }]))).toBe(true);
    expect(isSwitch(sw(0, 1, undefined))).toBe(false);
  });
});

describe('matchSwitchState', () => {
  const bytes = new Uint8Array([0x02, 0xff, 0xff, 0x01, 0x00]);

  it('matches the FIRST state in def order (duplicates allowed)', () => {
    const m = sw(1, 2, [
      { name: 'A', data: [0xff, 0x00] },
      { name: 'B', data: [0xff, 0xff] },
      { name: 'B-dup', data: [0xff, 0xff] },
    ]);
    expect(matchSwitchState(bytes, m)).toEqual({ actual: [0xff, 0xff], matched: 'B' });
  });

  it('full-length read with no equal state is CUSTOM (matched absent)', () => {
    const m = sw(0, 2, [{ name: 'On', data: [0x01, 0x00] }]);
    expect(matchSwitchState(bytes, m)).toEqual({ actual: [0x02, 0xff] });
  });

  it('truncated read NEVER matches — no prefix matching', () => {
    const m = sw(4, 2, [{ name: 'On', data: [0x00, 0x00] }]);
    expect(matchSwitchState(bytes, m)).toEqual({ actual: [0x00] });
  });

  it('fully out-of-range read returns empty actual, no match', () => {
    const m = sw(9, 1, [{ name: 'On', data: [0x00] }]);
    expect(matchSwitchState(bytes, m)).toEqual({ actual: [] });
  });

  it('a non-integer address (hand-edited project file) reads nothing — no undefined elements', () => {
    const m = sw(1.5, 1, [{ name: 'On', data: [0x00] }]);
    expect(matchSwitchState(bytes, m)).toEqual({ actual: [] });
  });

  it('a read ending exactly at the buffer boundary is full-length and matches', () => {
    const m = sw(3, 2, [{ name: 'On', data: [0x01, 0x00] }]);
    expect(matchSwitchState(bytes, m)).toEqual({ actual: [0x01, 0x00], matched: 'On' });
  });
});
