import type { EditJournal } from '@binanalyzer/core';

/**
 * Does any byte of the cell at `offset` differ from the file as opened?
 *
 * Per-byte, because applyEdit journals per byte: a 2-byte write whose high byte
 * matched the original leaves only the low byte in the journal, and the cell is
 * still changed.
 */
export function isCellChanged(journal: EditJournal, offset: number, width: number): boolean {
  for (let i = offset; i < offset + width; i++) if (journal.has(i)) return true;
  return false;
}

/**
 * The file-as-opened bytes, rebuilt from the working buffer plus the journal's
 * `original` entries. One source for everything F11 shows, so the grid and the
 * axis labels can never disagree about which state is on screen.
 */
export function originalBytes(working: Uint8Array, journal: EditJournal): Uint8Array {
  const scratch = Uint8Array.from(working);
  for (const [offset, e] of journal) scratch[offset] = e.original;
  return scratch;
}

/**
 * Is a just-committed edit text a genuine no-op?
 *
 * `beginEdit`/`beginAxisEdit` seed the input with a DISPLAY string
 * (`formatPhysical`, rounded to `scaling.digits`), which is frequently
 * coarser than the underlying raw LSB. Parsing that seed back with `Number()`
 * and re-quantising it does NOT reliably reproduce the raw byte it came
 * from — so comparing the PARSED number to the original value is not a safe
 * guard against a phantom write. Only exact TEXT identity between the seed
 * and the committed text proves nothing was typed.
 *
 * Compared TRIMMED (C1 residual): a seed of "15" and a committed " 15" is the
 * same no-op edit to the user — clicking into the cell and adding only
 * leading/trailing whitespace before clicking away must not rewrite the byte,
 * even though the raw strings differ.
 */
export function isUnchangedEdit(seed: string, text: string): boolean {
  return seed.trim() === text.trim();
}

/**
 * The bytes a view should display: the working buffer, or the file-as-opened
 * reconstruction when the original-values toggle is on.
 *
 * Deliberately a plain function, NOT a `$derived`. A derived returning the
 * store's own buffer memoizes on reference equality, so a later in-place edit
 * would never propagate and the view would render pre-edit numbers while the
 * bytes said otherwise. Callers must read the stores themselves.
 */
export function bytesForDisplay(
  working: Uint8Array,
  showOriginal: boolean,
  journal: EditJournal
): Uint8Array {
  return showOriginal ? originalBytes(working, journal) : working;
}
