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
  const scratch = Uint8Array.from(working);
  for (const [offset, e] of journal) scratch[offset] = e.original;
  return gridFromMap(scratch, m);
}
