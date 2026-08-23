import { describe, expect, it } from 'vitest';
import type { ChecksumReport } from '@binanalyzer/families';
import { isModalOutcome, saveVerdict, verdictHeadline, type SaveOutcome, type SaveVerdict } from '../src/lib/savereport.js';

const report = (patch: Partial<ChecksumReport> = {}): ChecksumReport => ({
  familyId: 'ms41',
  applies: true,
  valid: true,
  blocks: [
    { id: 'cal-0', label: 'Calibration 0', covers: [{ start: 0, end: 0x10 }], storedAt: 0x10, stored: 1, computed: 1, ok: true, correctable: true },
  ],
  skipped: [],
  notes: [],
  ...patch,
});

/** A checksum we verify but never write, mismatched. */
const programBlock = {
  id: 'program',
  label: 'Program',
  covers: [{ start: 0x0000, end: 0x4000 }, { start: 0x20000, end: 0x40000 }],
  storedAt: 0x6050,
  stored: 1,
  computed: 2,
  ok: false,
  correctable: false,
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
        { id: 'cal-0', label: 'c0', covers: [{ start: 0, end: 4 }], storedAt: 4, stored: 1, computed: 2, ok: false, correctable: true },
        { id: 'cal-1', label: 'c1', covers: [{ start: 6, end: 8 }], storedAt: 8, stored: 3, computed: 3, ok: true, correctable: true },
      ],
    });
    expect(saveVerdict({ report: r, editedOffsets: [] })).toEqual({ kind: 'invalid-after-correction', mismatched: 1 });
  });

  it('an edit INSIDE a non-correctable block ⇒ covered-by-uncorrected, counting only the covered bytes', () => {
    const r = report({ valid: false, blocks: [...report().blocks, programBlock] });
    expect(saveVerdict({ report: r, editedOffsets: [0x14000, 0x0002, 0x21000] })).toEqual({
      kind: 'covered-by-uncorrected',
      checksumId: 'program',
      coveredBytes: 2,
    });
  });

  it('range ends are EXCLUSIVE — the byte at `end` is not covered', () => {
    const block = { ...programBlock, id: 'x', covers: [{ start: 0x10, end: 0x20 }] };
    const r = report({ valid: false, blocks: [...report().blocks, block] });
    // 0x20 is outside, so nothing of the user's is covered — but the block is
    // still stale, which is the OTHER verdict, not `corrected`.
    expect(saveVerdict({ report: r, editedOffsets: [0x20] })).toEqual({
      kind: 'uncorrectable-mismatch',
      checksumId: 'x',
    });
    expect(saveVerdict({ report: r, editedOffsets: [0x1f] })).toMatchObject({ kind: 'covered-by-uncorrected' });
  });

  it('a stale checksum we never write, untouched by the edits ⇒ uncorrectable-mismatch', () => {
    const r = report({ valid: false, blocks: [...report().blocks, programBlock] });
    // 0x14000 is the MS41 cal window — outside every program region.
    expect(saveVerdict({ report: r, editedOffsets: [0x14000] })).toEqual({
      kind: 'uncorrectable-mismatch',
      checksumId: 'program',
    });
  });

  it('a CORRECTABLE block still bad outranks it — that is our correction failing', () => {
    const bad = { ...report().blocks[0]!, ok: false };
    const r = report({ valid: false, blocks: [bad, programBlock] });
    expect(saveVerdict({ report: r, editedOffsets: [0x100] })).toEqual({
      kind: 'invalid-after-correction',
      mismatched: 1,
    });
  });

  it('a non-correctable block that is OK changes nothing', () => {
    const r = report({ blocks: [...report().blocks, { ...programBlock, ok: true, computed: 1 }] });
    expect(saveVerdict({ report: r, editedOffsets: [0x100] })).toEqual({ kind: 'corrected' });
  });

  it('a skipped checksum is absent, so it can never be touched', () => {
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
