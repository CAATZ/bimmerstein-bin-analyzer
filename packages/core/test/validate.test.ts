import { describe, expect, it } from 'vitest';
import { validateMapDef } from '../src/validate.js';
import type { MapDef, ValueFormat } from '../src/types.js';

const u16be: ValueFormat = { width: 2, signed: false, endianness: 'big' };
const ok: MapDef = {
  id: 'a', name: 'a', address: 100, rows: 4, cols: 8, format: u16be,
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major',
  xAxis: { kind: 'referenced', count: 8, address: 60, format: u16be },
  yAxis: { kind: 'index', count: 4 },
  provenance: 'manual',
};
const BIN = 1024;

describe('validateMapDef', () => {
  it('accepts a valid map', () => {
    expect(validateMapDef(ok, BIN)).toEqual({ ok: true, value: ok });
  });
  it('rejects data out of bounds', () => {
    const r = validateMapDef({ ...ok, address: BIN - 10 }, BIN);
    expect(r.ok).toBe(false);
  });
  it('rejects axis count mismatch', () => {
    const r = validateMapDef({ ...ok, xAxis: { kind: 'index', count: 7 } }, BIN);
    expect(r.ok).toBe(false);
  });
  it('rejects referenced axis out of bounds', () => {
    const r = validateMapDef({ ...ok, xAxis: { kind: 'referenced', count: 8, address: BIN - 4, format: u16be } }, BIN);
    expect(r.ok).toBe(false);
  });
  it('rejects confidence on non-auto and missing confidence on auto', () => {
    expect(validateMapDef({ ...ok, confidence: 0.5 }, BIN).ok).toBe(false);
    expect(validateMapDef({ ...ok, provenance: 'auto' }, BIN).ok).toBe(false);
  });
  it('rejects rows/cols < 1 and negative address', () => {
    expect(validateMapDef({ ...ok, rows: 0 }, BIN).ok).toBe(false);
    expect(validateMapDef({ ...ok, address: -2 }, BIN).ok).toBe(false);
  });
  it('rejects detector on a non-auto map; accepts it on an auto map', () => {
    // `ok` is provenance 'manual' — a detector tier makes no sense there.
    expect(validateMapDef({ ...ok, detector: 'family' }, BIN).ok).toBe(false);
    const auto: MapDef = { ...ok, provenance: 'auto', confidence: 0.9, detector: 'structural' };
    expect(validateMapDef(auto, BIN).ok).toBe(true);
  });
});

describe('validateMapDef — switch states', () => {
  const u8: ValueFormat = { width: 1, signed: false, endianness: 'little' };
  // Canonical switch shape: cols 1, u8 unsigned, identity scaling, no axes.
  const base: MapDef = {
    id: 'sw', name: 'sw', address: 0, rows: 2, cols: 1, format: u8,
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major',
    provenance: 'imported',
  };

  it('rejects empty states', () => {
    const r = validateMapDef({ ...base, states: [] }, BIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/states must be non-empty/);
  });

  it('rejects cols !== 1 with states', () => {
    const r = validateMapDef({ ...base, cols: 2, states: [{ name: 'On', data: [1, 0] }] }, BIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cols 1 and width 1/);
  });

  it('rejects format.width !== 1 with states', () => {
    const r = validateMapDef(
      { ...base, format: { width: 2, signed: false, endianness: 'little' }, states: [{ name: 'On', data: [1, 0] }] },
      BIN,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cols 1 and width 1/);
  });

  it('rejects signed format with states', () => {
    const r = validateMapDef(
      { ...base, format: { width: 1, signed: true, endianness: 'little' }, states: [{ name: 'On', data: [1, 0] }] },
      BIN,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unsigned/);
  });

  it('rejects non-identity scaling (factor) with states', () => {
    const r = validateMapDef(
      { ...base, scaling: { factor: 2, offset: 0, units: '', digits: 0 }, states: [{ name: 'On', data: [1, 0] }] },
      BIN,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/identity scaling/);
  });

  it('rejects a rawExpression present with states', () => {
    const r = validateMapDef(
      {
        ...base,
        scaling: { factor: 1, offset: 0, units: '', digits: 0, rawExpression: 'x*2' },
        states: [{ name: 'On', data: [1, 0] }],
      },
      BIN,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/identity scaling/);
  });

  it('rejects an xAxis present with states', () => {
    const r = validateMapDef(
      { ...base, xAxis: { kind: 'index', count: 1 }, states: [{ name: 'On', data: [1, 0] }] },
      BIN,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot carry axes/);
  });

  it('rejects an empty state name', () => {
    const r = validateMapDef({ ...base, states: [{ name: '', data: [1, 0] }] }, BIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/state name/);
  });

  it('rejects a state whose data length does not match rows*cols*width', () => {
    const r = validateMapDef({ ...base, states: [{ name: 'On', data: [1, 0, 0] }] }, BIN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('3');
      expect(r.error).toContain('2');
    }
  });

  it.each([[256], [-1], [2.5]])('rejects state data value %j outside integers in [0, 255]', (bad) => {
    const r = validateMapDef({ ...base, states: [{ name: 'On', data: [bad, 0] }] }, BIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/integers in \[0, 255\]/);
  });

  it('allows duplicate state names (uniqueness not enforced)', () => {
    const m: MapDef = {
      ...base,
      states: [
        { name: 'Same', data: [1, 0] },
        { name: 'Same', data: [0, 1] },
      ],
    };
    expect(validateMapDef(m, BIN)).toEqual({ ok: true, value: m });
  });
});
