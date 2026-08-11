import { describe, expect, it } from 'vitest';
import type { AxisDef, MapDef, ValueFormat } from '@binanalyzer/core';
import { axisByteOffset, axisEditability, isMonotonic, mapsSharingAxis } from '../src/lib/axisedit.js';

// `format` is typed `format?: ValueFormat | undefined` here (rather than
// `Partial<AxisDef>`'s `format?: ValueFormat`) so the "no format" test below
// can pass `format: undefined` explicitly under exactOptionalPropertyTypes.
const ref = (over: Partial<Omit<AxisDef, 'format'>> & { format?: ValueFormat | undefined } = {}): AxisDef => ({
  kind: 'referenced', address: 0x100, count: 4,
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 }, ...over,
}) as AxisDef;
const m = (id: string, axis: AxisDef): MapDef => ({
  id, name: id, address: 0x900, rows: 1, cols: 4,
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  orientation: 'row-major', provenance: 'manual', xAxis: axis,
});

describe('axisEditability', () => {
  it('accepts a referenced axis with a format', () => {
    expect(axisEditability(ref())).toEqual({ editable: true });
  });

  it('rejects literal and index axes as definition concerns, not byte concerns', () => {
    expect(axisEditability({ kind: 'literal', count: 2, values: [1, 2] }).editable).toBe(false);
    expect(axisEditability({ kind: 'index', count: 2 }).editable).toBe(false);
  });

  it('rejects a referenced axis with no format — width and endianness are unknown', () => {
    const { editable, reason } = axisEditability(ref({ format: undefined }));
    expect(editable).toBe(false);
    expect(reason).toMatch(/format/i);
  });

  it('rejects a missing axis', () => {
    expect(axisEditability(undefined).editable).toBe(false);
  });
});

describe('mapsSharingAxis', () => {
  it('names the other maps whose axis bytes OVERLAP, not merely match', () => {
    const a = ref();                                  // 0x100, 4 x u8 → [0x100,0x104)
    const overlapping = ref({ address: 0x102 });      // [0x102,0x106) → overlaps
    const apart = ref({ address: 0x200 });
    const names = mapsSharingAxis(
      [m('self', a), m('other', overlapping), m('far', apart)],
      a,
      'self'
    );
    expect(names).toEqual(['other']);
  });

  it('excludes the map being edited', () => {
    const a = ref();
    expect(mapsSharingAxis([m('self', a)], a, 'self')).toEqual([]);
  });
});

/**
 * I3 (final whole-branch review): the axis header cells need the same
 * offset-keyed diff check `<td>` already uses. `axisByteOffset` is the
 * missing piece — it must agree with `editAxisValue`'s own offset math
 * (`axis.address + index * axis.format.width`) exactly, or the highlight and
 * the actual write would disagree.
 */
describe('axisByteOffset', () => {
  it('returns the byte offset for a referenced axis, matching editAxisValue\'s own math', () => {
    expect(axisByteOffset(ref({ address: 0x100 }), 0)).toBe(0x100);
    expect(axisByteOffset(ref({ address: 0x100 }), 3)).toBe(0x103);
  });

  it('honours a wider format', () => {
    const wide = ref({ address: 0x200, format: { width: 2, signed: false, endianness: 'little' } });
    expect(axisByteOffset(wide, 2)).toBe(0x200 + 2 * 2);
  });

  it('is null for a literal axis — nothing is stored in the bin', () => {
    expect(axisByteOffset({ kind: 'literal', count: 2, values: [1, 2] }, 0)).toBeNull();
  });

  it('is null for an index axis — nothing is stored anywhere', () => {
    expect(axisByteOffset({ kind: 'index', count: 4 }, 0)).toBeNull();
  });

  it('is null for a referenced axis with no format', () => {
    expect(axisByteOffset(ref({ format: undefined }), 0)).toBeNull();
  });

  it('is null when the axis itself is undefined', () => {
    expect(axisByteOffset(undefined, 0)).toBeNull();
  });
});

describe('isMonotonic', () => {
  it('accepts ascending and rejects a broken order', () => {
    expect(isMonotonic([1, 2, 3, 4])).toBe(true);
    expect(isMonotonic([1, 3, 2, 4])).toBe(false);
  });

  it('accepts descending, which some axes legitimately are', () => {
    expect(isMonotonic([9, 6, 3])).toBe(true);
  });

  it('treats equal neighbours as still monotonic', () => {
    expect(isMonotonic([1, 1, 2])).toBe(true);
  });
});
