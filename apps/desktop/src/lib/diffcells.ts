import type { EditJournal, MapDef } from '@binanalyzer/core';
import { gridFromMap } from './griddata.js';
import type { SurfaceGrid } from './griddata.js';

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
 * The same grid the view shows, decoded from the FILE AS OPENED (F11).
 *
 * Reconstructed from the working buffer plus the journal's `original` values
 * rather than read from the bin image's own byte array. Two reasons: no view
 * then needs to touch the original buffer at all, so the guard test stays
 * absolute; and the F11 display and the diff highlighting are driven by the
 * SAME journal, so they cannot drift apart.
 */
export function originalGrid(
  working: Uint8Array,
  journal: EditJournal,
  m: MapDef
): SurfaceGrid {
  return gridFromMap(originalBytes(working, journal), m);
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
 */
export function isUnchangedEdit(seed: string, text: string): boolean {
  return seed === text;
}
