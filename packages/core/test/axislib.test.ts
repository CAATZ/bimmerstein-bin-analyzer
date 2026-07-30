import { describe, expect, it } from 'vitest';
import { validateAxisLibEntry, validateMapDef } from '../src/validate.js';
import type { AxisLibEntry, MapDef, ValueFormat } from '../src/types.js';

const u16be: ValueFormat = { width: 2, signed: false, endianness: 'big' };
const BIN = 1024;

function entry(over: Partial<AxisLibEntry> = {}): AxisLibEntry {
  return {
    id: 'e1',
    name: 'RPM',
    axis: { kind: 'referenced', address: 0x60, count: 8, format: u16be },
    ...over,
  };
}

describe('validateAxisLibEntry', () => {
  it('accepts a referenced entry inside the bin', () => {
    expect(validateAxisLibEntry(entry(), BIN)).toEqual({ ok: true, value: entry() });
  });
  it('accepts a literal entry with matching values length', () => {
    const e = entry({ axis: { kind: 'literal', count: 3, values: [1, 2, 3] } });
    expect(validateAxisLibEntry(e, BIN).ok).toBe(true);
  });
  it('rejects empty id and empty name', () => {
    expect(validateAxisLibEntry(entry({ id: '' }), BIN).ok).toBe(false);
    expect(validateAxisLibEntry(entry({ name: '' }), BIN).ok).toBe(false);
  });
  it('rejects an index-kind axis (carries no information)', () => {
    expect(validateAxisLibEntry(entry({ axis: { kind: 'index', count: 8 } }), BIN).ok).toBe(false);
  });
  it('rejects an entry axis carrying its own libId', () => {
    const e = entry({ axis: { kind: 'referenced', address: 0x60, count: 8, format: u16be, libId: 'x' } });
    expect(validateAxisLibEntry(e, BIN).ok).toBe(false);
  });
  it('rejects a referenced span leaving the bin', () => {
    const e = entry({ axis: { kind: 'referenced', address: BIN - 4, count: 8, format: u16be } });
    expect(validateAxisLibEntry(e, BIN).ok).toBe(false);
  });
  it('rejects a literal values length mismatch and a count below 1', () => {
    expect(validateAxisLibEntry(entry({ axis: { kind: 'literal', count: 4, values: [1] } }), BIN).ok).toBe(false);
    expect(validateAxisLibEntry(entry({ axis: { kind: 'literal', count: 0, values: [] } }), BIN).ok).toBe(false);
  });
});

describe('AxisDef.libId is valid map metadata', () => {
  it('validateMapDef accepts a map whose axis carries libId', () => {
    const map: MapDef = {
      id: 'm', name: 'M', address: 100, rows: 4, cols: 8, format: u16be,
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major',
      xAxis: { kind: 'referenced', count: 8, address: 0x60, format: u16be, libId: 'e1' },
      provenance: 'manual',
    };
    expect(validateMapDef(map, BIN)).toEqual({ ok: true, value: map });
  });
});
