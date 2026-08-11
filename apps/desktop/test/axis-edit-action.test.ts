import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AxisDef, MapDef } from '@binanalyzer/core';
import { createBinImage, readValue } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { toasts, workingBytes } from '../src/store/stores.js';

const u8 = { width: 1, signed: false, endianness: 'little' } as const;
const axis: AxisDef = {
  kind: 'referenced', address: 0x100, count: 4, format: u8,
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
};
const withAxis = (over: Partial<MapDef> = {}): MapDef => ({
  id: 'm1', name: 'M', address: 0x900, rows: 1, cols: 4, format: u8,
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major', provenance: 'manual', xAxis: axis, ...over,
});

beforeEach(() => {
  a.resetStores();
  const bytes = new Uint8Array(0x200);
  bytes.set([10, 20, 30, 40], 0x100); // an ascending breakpoint axis
  a.setBin(createBinImage(bytes, 'ax.bin'));
});

describe('editAxisValue', () => {
  it('writes the breakpoint through the AXIS format and scaling', () => {
    const r = a.editAxisValue(withAxis(), 'x', 1, 25);
    expect(r).toMatchObject({ ok: true });
    expect(readValue(get(workingBytes)!, 0x101, u8)).toBe(25);
  });

  it('APPLIES a non-monotonic edit and warns rather than blocking it', () => {
    const r = a.editAxisValue(withAxis(), 'x', 1, 99); // 10, 99, 30, 40
    expect(r).toMatchObject({ ok: true });
    expect(get(workingBytes)![0x101]).toBe(99); // applied
    expect(get(toasts).some((t) => /no longer in order/i.test(t.text))).toBe(true);
  });

  it('does not warn when the axis stays ordered', () => {
    a.editAxisValue(withAxis(), 'x', 1, 25);
    expect(get(toasts).some((t) => /no longer in order/i.test(t.text))).toBe(false);
  });

  it('refuses a literal axis with a reason naming map properties', () => {
    const lit: AxisDef = { kind: 'literal', count: 2, values: [1, 2] };
    const r = a.editAxisValue(withAxis({ xAxis: lit }), 'x', 0, 5);
    expect(r).toEqual({ ok: false, reason: 'A literal axis is stored in the definition, not the bin. Edit it in map properties.' });
  });
});
