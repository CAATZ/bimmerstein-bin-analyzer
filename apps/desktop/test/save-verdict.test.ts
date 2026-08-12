import { describe, expect, it } from 'vitest';
import type { ChecksumReport } from '@binanalyzer/families';
import { isModalOutcome, saveVerdict, verdictHeadline, type SaveOutcome, type SaveVerdict } from '../src/lib/savereport.js';

const report = (patch: Partial<ChecksumReport> = {}): ChecksumReport => ({
  familyId: 'ms41',
  applies: true,
  valid: true,
  blocks: [
    { id: 'cal-0', label: 'Calibration 0', covers: { start: 0, end: 0x10 }, storedAt: 0x10, stored: 1, computed: 1, ok: true },
  ],
  skipped: [],
  notes: [],
  ...patch,
});

const programSkipped = {
  id: 'program',
  reason: 'not vouched for',
  covers: [{ start: 0x0000, end: 0x4000 }, { start: 0x20000, end: 0x40000 }],
};

describe('saveVerdict', () => {
  it('no module at load ⇒ unrecognised', () => {
    expect(saveVerdict({ report: undefined, editedOffsets: [1, 2] })).toEqual({ kind: 'unrecognised' });
  });

  it('a module that no longer recognises the edited image ⇒ structure-changed', () => {
    const r = report({ applies: false, valid: false, blocks: [] });
    expect(saveVerdict({ report: r, editedOffsets: [] })).toEqual({ kind: 'structure-changed' });
  });

  it('corrected but still invalid ⇒ invalid-after-correction, counting the bad blocks', () => {
    const r = report({
      valid: false,
      blocks: [
        { id: 'cal-0', label: 'c0', covers: { start: 0, end: 4 }, storedAt: 4, stored: 1, computed: 2, ok: false },
        { id: 'cal-1', label: 'c1', covers: { start: 6, end: 8 }, storedAt: 8, stored: 3, computed: 3, ok: true },
      ],
    });
    expect(saveVerdict({ report: r, editedOffsets: [] })).toEqual({ kind: 'invalid-after-correction', mismatched: 1 });
  });

  it('edits outside every skipped range ⇒ corrected', () => {
    const r = report({ skipped: [programSkipped] });
    // 0x14000 is the MS41 full-read cal window — deliberately outside all of them.
    expect(saveVerdict({ report: r, editedOffsets: [0x14000, 0x14001] })).toEqual({ kind: 'corrected' });
  });

  it('an edit INSIDE a skipped range ⇒ covered-by-uncorrected, counting only the covered bytes', () => {
    const r = report({ skipped: [programSkipped] });
    expect(saveVerdict({ report: r, editedOffsets: [0x14000, 0x0002, 0x21000] })).toEqual({
      kind: 'covered-by-uncorrected',
      checksumId: 'program',
      coveredBytes: 2,
    });
  });

  it('range ends are EXCLUSIVE — the byte at `end` is not covered', () => {
    const r = report({ skipped: [{ id: 'x', reason: 'r', covers: [{ start: 0x10, end: 0x20 }] }] });
    expect(saveVerdict({ report: r, editedOffsets: [0x20] })).toEqual({ kind: 'corrected' });
    expect(saveVerdict({ report: r, editedOffsets: [0x1f] })).toMatchObject({ kind: 'covered-by-uncorrected' });
  });

  it('a skipped checksum with NO ranges can never be touched', () => {
    const r = report({ skipped: [{ id: 'boot', reason: 'lives outside a 24 KB partial' }] });
    expect(saveVerdict({ report: r, editedOffsets: [0, 1, 2, 3] })).toEqual({ kind: 'corrected' });
  });
});

describe('presentation', () => {
  const ok = (verdict: SaveVerdict): SaveOutcome => ({
    ok: true, path: 'C:\\t.bin', name: 't.bin', size: 4, sha256: 'a', verdict,
    corrected: [], report: undefined, editedBytes: 0,
  });

  it('only a clean correction stays out of the way', () => {
    expect(isModalOutcome(ok({ kind: 'corrected' }))).toBe(false);
    expect(isModalOutcome(ok({ kind: 'unrecognised' }))).toBe(true);
    expect(isModalOutcome(ok({ kind: 'structure-changed' }))).toBe(true);
    expect(isModalOutcome(ok({ kind: 'covered-by-uncorrected', checksumId: 'program', coveredBytes: 2 }))).toBe(true);
    expect(isModalOutcome(ok({ kind: 'invalid-after-correction', mismatched: 1 }))).toBe(true);
  });

  it('a failure is always modal', () => {
    expect(isModalOutcome({ ok: false, path: null, reason: 'nope' })).toBe(true);
  });

  it('every verdict has a headline that names what is wrong', () => {
    expect(verdictHeadline({ kind: 'corrected' })).toMatch(/corrected/i);
    expect(verdictHeadline({ kind: 'unrecognised' })).toMatch(/not checksum-corrected/i);
    expect(verdictHeadline({ kind: 'structure-changed' })).toMatch(/no longer recognis/i);
    expect(verdictHeadline({ kind: 'covered-by-uncorrected', checksumId: 'program', coveredBytes: 3 })).toMatch(/program/);
    expect(verdictHeadline({ kind: 'covered-by-uncorrected', checksumId: 'program', coveredBytes: 3 })).toMatch(/3/);
    expect(verdictHeadline({ kind: 'invalid-after-correction', mismatched: 2 })).toMatch(/still/i);
  });
});
