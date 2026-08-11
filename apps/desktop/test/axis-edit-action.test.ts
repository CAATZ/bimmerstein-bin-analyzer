import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AxisDef, MapDef } from '@binanalyzer/core';
import { createBinImage, readValue } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { axisByteOffset } from '../src/lib/axisedit.js';
import { isCellChanged } from '../src/lib/diffcells.js';
import { editJournal, toasts, workingBytes } from '../src/store/stores.js';

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

/**
 * I3 (final whole-branch review): after editing an axis breakpoint,
 * `isCellChanged` at that value's `axisByteOffset` must agree with the
 * journal — this is what lets the axis header `<th>` carry `class:changed`
 * the same way a `<td>` already does.
 */
describe('axisByteOffset + isCellChanged (I3 — axis header diff highlighting)', () => {
  it('marks the edited index changed and leaves an untouched index alone', () => {
    const m = withAxis();
    a.editAxisValue(m, 'x', 1, 25);
    const journal = get(editJournal);
    const editedOff = axisByteOffset(axis, 1)!;
    const untouchedOff = axisByteOffset(axis, 2)!;
    expect(isCellChanged(journal, editedOff, axis.format!.width)).toBe(true);
    expect(isCellChanged(journal, untouchedOff, axis.format!.width)).toBe(false);
  });

  it('editing back to the original clears the highlight', () => {
    const m = withAxis();
    a.editAxisValue(m, 'x', 1, 25); // was 20 at index 1
    a.editAxisValue(m, 'x', 1, 20); // back to the original
    const journal = get(editJournal);
    expect(isCellChanged(journal, axisByteOffset(axis, 1)!, axis.format!.width)).toBe(false);
  });
});
