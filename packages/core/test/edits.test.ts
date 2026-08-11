import { describe, expect, it } from 'vitest';
import type { EditJournal, ValueFormat } from '../src/index.js';
import { applyEdit, changedOffsets, materialize, revertOffsets } from '../src/index.js';

const u8: ValueFormat = { width: 1, signed: false, endianness: 'little' };
const be16: ValueFormat = { width: 2, signed: false, endianness: 'big' };

function setup(): { original: Uint8Array; working: Uint8Array; journal: EditJournal } {
  const original = Uint8Array.from({ length: 16 }, (_, i) => i * 2);
  return { original, working: Uint8Array.from(original), journal: new Map() };
}

describe('applyEdit', () => {
  it('writes the cell and records the ORIGINAL byte, not the new one', () => {
    const { original, working, journal } = setup();
    applyEdit({ working, original, journal, offset: 4, format: u8, raw: 99 });
    expect(working[4]).toBe(99);
    expect(journal.get(4)).toEqual({ original: 8, current: 99 });
  });

  it('a second edit to the same cell keeps the FIRST original', () => {
    const { original, working, journal } = setup();
    applyEdit({ working, original, journal, offset: 4, format: u8, raw: 99 });
    applyEdit({ working, original, journal, offset: 4, format: u8, raw: 123 });
    expect(journal.get(4)).toEqual({ original: 8, current: 123 });
  });

  it('editing a cell BACK to its original value deletes the entry', () => {
    const { original, working, journal } = setup();
    applyEdit({ working, original, journal, offset: 4, format: u8, raw: 99 });
    expect(journal.has(4)).toBe(true);
    applyEdit({ working, original, journal, offset: 4, format: u8, raw: 8 });
    expect(journal.has(4)).toBe(false);
    expect(working[4]).toBe(8);
  });

  it('records one entry per BYTE of a multi-byte cell', () => {
    const { original, working, journal } = setup();
    applyEdit({ working, original, journal, offset: 6, format: be16, raw: 0x1234 });
    expect(changedOffsets(journal)).toEqual([6, 7]);
    expect(journal.get(6)).toEqual({ original: 12, current: 0x12 });
    expect(journal.get(7)).toEqual({ original: 14, current: 0x34 });
  });

  it('drops only the bytes of a multi-byte cell that actually differ', () => {
    const { original, working, journal } = setup();
    // original[6]=12, original[7]=14 → write 12,99: the high byte is unchanged.
    applyEdit({ working, original, journal, offset: 6, format: be16, raw: (12 << 8) | 99 });
    expect(changedOffsets(journal)).toEqual([7]);
  });
});

describe('materialize', () => {
  it('rebuilds the working buffer from the original plus the journal', () => {
    const { original, working, journal } = setup();
    applyEdit({ working, original, journal, offset: 4, format: u8, raw: 99 });
    applyEdit({ working, original, journal, offset: 9, format: u8, raw: 7 });
    const rebuilt = materialize(original, journal);
    expect([...rebuilt]).toEqual([...working]);
  });

  it('does not mutate the original', () => {
    const { original, working, journal } = setup();
    const before = Uint8Array.from(original);
    applyEdit({ working, original, journal, offset: 4, format: u8, raw: 99 });
    materialize(original, journal);
    expect([...original]).toEqual([...before]);
  });
});

describe('revertOffsets', () => {
  it('restores the recorded originals and clears those entries', () => {
    const { original, working, journal } = setup();
    applyEdit({ working, original, journal, offset: 4, format: u8, raw: 99 });
    applyEdit({ working, original, journal, offset: 9, format: u8, raw: 7 });
    revertOffsets({ working, journal, offsets: [4] });
    expect(working[4]).toBe(8);
    expect(journal.has(4)).toBe(false);
    expect(journal.has(9)).toBe(true); // untouched
  });

  it('ignores offsets that were never edited', () => {
    const { working, journal } = setup();
    expect(() => revertOffsets({ working, journal, offsets: [3] })).not.toThrow();
  });
});

describe('changedOffsets', () => {
  it('returns the changed offsets in ascending order', () => {
    const { original, working, journal } = setup();
    applyEdit({ working, original, journal, offset: 9, format: u8, raw: 1 });
    applyEdit({ working, original, journal, offset: 2, format: u8, raw: 1 });
    expect(changedOffsets(journal)).toEqual([2, 9]);
  });
});
