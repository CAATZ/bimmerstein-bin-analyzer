import { describe, expect, it } from 'vitest';
import { isSwitch, matchSwitchState } from '../src/lib/switchdata.js';
import type { MapDef } from '@binanalyzer/core';

// The desktop's single import point re-exports the core helpers (curvedata precedent).
describe('switchdata re-exports', () => {
  it('exposes working isSwitch/matchSwitchState', () => {
    const m: MapDef = {
      id: 't', name: 'sw', address: 1, rows: 2, cols: 1,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'imported',
      states: [{ name: 'On', data: [0xff, 0x00] }],
    };
    expect(isSwitch(m)).toBe(true);
    expect(matchSwitchState(new Uint8Array([0, 0xff, 0x00]), m)).toEqual({ actual: [0xff, 0x00], matched: 'On' });
  });
});
