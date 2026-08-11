import type { ValueFormat } from './types.js';
import { writeValue } from './codec.js';

/**
 * offset → what the file as opened held, and what the buffer holds now.
 *
 * Recording the ORIGINAL is what makes revert a direct restore and keeps
 * repeated edits to one cell idempotent. Recording the CURRENT is what makes
 * the journal a COMPLETE description of the edit state, so undo can snapshot
 * the journal alone instead of copying the whole buffer.
 */
export type EditJournal = Map<number, { original: number; current: number }>;

/**
 * Write one cell into `working` and record the change.
 *
 * Journals per BYTE, not per cell: a 2-byte write whose high byte happens to
 * match the original records only the low byte, so the diff never highlights a
 * byte that did not actually change.
 *
 * An entry is DELETED when a byte returns to its original value, so "changed"
 * always means genuinely different from the file as opened — and the journal,
 * plus every undo snapshot of it, stays proportional to what actually differs.
 */
export function applyEdit(args: {
  working: Uint8Array;
  original: Uint8Array;
  journal: EditJournal;
  offset: number;
  format: ValueFormat;
  raw: number;
}): void {
  const { working, original, journal, offset, format, raw } = args;
  writeValue(working, offset, format, raw);
  for (let i = offset; i < offset + format.width; i++) {
    const was = original[i]!;
    const now = working[i]!;
    if (now === was) journal.delete(i);
    else journal.set(i, { original: was, current: now });
  }
}

/** Restore the recorded original at each offset and forget those entries. */
export function revertOffsets(args: {
  working: Uint8Array;
  journal: EditJournal;
  offsets: readonly number[];
}): void {
  const { working, journal, offsets } = args;
  for (const o of offsets) {
    const e = journal.get(o);
    if (e === undefined) continue;
    working[o] = e.original;
    journal.delete(o);
  }
}

/**
 * Rebuild a working buffer from the original plus a journal. This is what lets
 * undo snapshot the sparse journal rather than a copy of the buffer.
 */
export function materialize(original: Uint8Array, journal: EditJournal): Uint8Array {
  const out = Uint8Array.from(original);
  for (const [offset, e] of journal) out[offset] = e.current;
  return out;
}

/** The changed offsets, ascending — this IS the diff. */
export function changedOffsets(journal: EditJournal): number[] {
  return [...journal.keys()].sort((a, b) => a - b);
}
