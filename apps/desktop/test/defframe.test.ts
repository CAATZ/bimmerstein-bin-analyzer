import { describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { axisSaRepresentable, frameDefMaps, isMs41FullRead, saRepresentableSpan, unframeDefMaps } from '../src/lib/defframe.js';

const U16LE = { width: 2, signed: false, endianness: 'little' } as const;
const U8 = { width: 1, signed: false, endianness: 'little' } as const;

/** 8×1 u16 table with a referenced u8 y-axis — mirrors the real MS41 dwell table (SA 0x670 / axis 0x5F3). */
function defMap(address: number, over: Partial<MapDef> = {}): MapDef {
  return {
    id: `imp-0x${address.toString(16)}`,
    name: `T 0x${address.toString(16)}`,
    address,
    rows: 8,
    cols: 1,
    format: { ...U16LE },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major',
    provenance: 'imported',
    yAxis: { kind: 'referenced', address: 0x5f3, count: 8, format: { ...U8 } },
    ...over,
  };
}

describe('isMs41FullRead', () => {
  it('splits at MS41_MIN_BIN_LEN (0x18000)', () => {
    expect(isMs41FullRead(0x18000)).toBe(true);
    expect(isMs41FullRead(0x40000)).toBe(true);
    expect(isMs41FullRead(0x17fff)).toBe(false);
    expect(isMs41FullRead(0x6000)).toBe(false);
  });
});

describe('frameDefMaps (SA → file offset)', () => {
  it('maps the byte-verified dwell vectors: 0x670 → 0x14670, axis 0x5F3 → 0x145F3', () => {
    const r = frameDefMaps([defMap(0x670)]);
    expect(r.skipped).toEqual([]);
    expect(r.maps[0]!.address).toBe(0x14670);
    expect(r.maps[0]!.yAxis!.address).toBe(0x145f3);
  });

  it('maps SA-space boundaries: 0x4000 → 0x10000, cal-end-capped run allowed', () => {
    const lowHalfEnd = defMap(0x3ff0, { rows: 8, cols: 1 }); // 16 bytes: 0x3ff0+16 == 0x4000, allowed
    const upperStart = defMap(0x4000, { rows: 1, cols: 2 });
    const r = frameDefMaps([lowHalfEnd, upperStart]);
    expect(r.skipped).toEqual([]);
    expect(r.maps[0]!.address).toBe(0x17ff0);
    expect(r.maps[1]!.address).toBe(0x10000);
  });

  it('skips a data span crossing the SA 0x4000 seam', () => {
    const r = frameDefMaps([defMap(0x3ffe)]); // 16 bytes from 0x3ffe crosses 0x4000
    expect(r.maps).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toContain('imp-0x3ffe');
  });

  it('skips an SA outside the cal window and a seam-crossing AXIS', () => {
    const outOfCal = defMap(0x6000);
    const badAxis = defMap(0x100, {
      yAxis: { kind: 'referenced', address: 0x3ffe, count: 8, format: { ...U8 } }, // 8 bytes cross 0x4000
    });
    const r = frameDefMaps([outOfCal, badAxis]);
    expect(r.maps).toEqual([]);
    expect(r.skipped).toHaveLength(2);
  });

  it('leaves literal and index axes untouched', () => {
    const m = defMap(0x670, {
      xAxis: { kind: 'literal', count: 2, values: [1, 2] },
      yAxis: { kind: 'index', count: 8 },
    });
    const r = frameDefMaps([m]);
    expect(r.maps[0]!.xAxis).toEqual({ kind: 'literal', count: 2, values: [1, 2] });
    expect(r.maps[0]!.yAxis).toEqual({ kind: 'index', count: 8 });
  });
});

describe('unframeDefMaps (file offset → SA)', () => {
  it('is the exact inverse of frameDefMaps', () => {
    const original = defMap(0x670);
    const framed = frameDefMaps([original]).maps;
    const back = unframeDefMaps(framed);
    expect(back.skipped).toEqual([]);
    expect(back.maps[0]).toEqual(original);
  });

  it('skips maps outside the mapped cal window (e.g. a manual map at 0x20)', () => {
    const r = unframeDefMaps([defMap(0x20)]);
    expect(r.maps).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });
});

describe('saRepresentableSpan / axisSaRepresentable', () => {
  it('accepts spans inside a mapped cal chunk', () => {
    expect(saRepresentableSpan(0x14000, 16)).toBe(true); // SA 0x0000
    expect(saRepresentableSpan(0x10000, 16)).toBe(true); // SA 0x4000
  });
  it('rejects offsets outside the mapped cal chunks', () => {
    expect(saRepresentableSpan(0x0, 16)).toBe(false);
    expect(saRepresentableSpan(0x20000, 16)).toBe(false);
  });
  it('rejects spans crossing the 0x4000 SA seam', () => {
    expect(saRepresentableSpan(0x17ff8, 16)).toBe(false); // SA 0x3FF8 + 16 crosses 0x4000
  });
  it('literal and index axes are always representable; referenced follows the span rule', () => {
    expect(axisSaRepresentable({ kind: 'literal', count: 2, values: [0, 1] })).toBe(true);
    expect(axisSaRepresentable({ kind: 'index', count: 4 })).toBe(true);
    expect(axisSaRepresentable({ kind: 'referenced', address: 0x14000, count: 8, format: { width: 2, signed: false, endianness: 'big' } })).toBe(true);
    expect(axisSaRepresentable({ kind: 'referenced', address: 0x0, count: 8, format: { width: 2, signed: false, endianness: 'big' } })).toBe(false);
  });
});
