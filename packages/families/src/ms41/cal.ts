import { crc16 } from '../crc16.js';
import { be16, u16le } from '../bytes.js';

/** Marker that locates the calibration checksum table. */
export const CAL_MAGIC = new Uint8Array([0x4e, 0x00, 0xff, 0xff]);

/** Max entries walked — a bound carried over from the reference. */
const MAX_ENTRIES = 20;

/** File offset of the cal table, or -1. */
export function findCalTable(d: Uint8Array): number {
  outer: for (let i = 0; i + CAL_MAGIC.length <= d.length; i++) {
    for (let j = 0; j < CAL_MAGIC.length; j++) if (d[i + j] !== CAL_MAGIC[j]) continue outer;
    return i;
  }
  return -1;
}

export interface CalEntry {
  /** FILE offset where this entry's checksum is stored (u16 LE). */
  store: number;
  /** FILE offset the covered range starts at. */
  from: number;
  /** Computed CRC over [from, store). */
  calc: number;
}

export interface CalWalk {
  entries: CalEntry[];
  /**
   * true only when the walk ended on the 0xFFFF terminator. false means it died
   * on a bounds/backwards guard or ran into MAX_ENTRIES — which a real table
   * never does, and a chance match usually does.
   */
  terminated: boolean;
}

/**
 * Minimum entries before a terminating walk counts as a real calibration table.
 *
 * MEASURED, not guessed. Both real MS41 framings walk 16 entries and terminate
 * cleanly. Against adversarial images shaped like firmware — random bytes with
 * erased-flash 0xFF runs and the magic planted at a random offset — a
 * terminating walk reaches 1 entry 20% of the time, 2 entries 3.1%, 3 entries
 * 0.31%, and 4 entries 0 times in 8000. Four sits at that cliff and still
 * leaves a 4x margin under the real 16, so it is not fitted to the two bins we
 * happen to hold.
 */
const MIN_ENTRIES = 4;

/**
 * Walk the cal checksum table. Each entry is a u16-LE offset RELATIVE TO
 * `start`, read at the current `pos`; it names where that entry's checksum
 * lives. The covered range is [pos, store) and the next entry begins at
 * store + 2. The walk stops on a 0xFFFF offset, on a store that would run past
 * the buffer, or on one that moves backwards.
 */
export function calWalk(d: Uint8Array, start: number): CalWalk {
  const entries: CalEntry[] = [];
  if (start < 0 || start + 0x10 > d.length) return { entries, terminated: false };
  const init = be16(d, start + 0x0e);
  let pos = start;
  for (let i = 0; i < MAX_ENTRIES; i++) {
    const ss = u16le(d, pos);
    if (ss === 0xffff) return { entries, terminated: true };
    const store = start + ss;
    if (store + 2 > d.length || store < pos) break;
    entries.push({ store, from: pos, calc: crc16(d.subarray(pos, store), init) });
    pos = store + 2;
  }
  return { entries, terminated: false };
}

/** The entries only, for callers that already know the table is real. */
export function calEntries(d: Uint8Array, start: number): CalEntry[] {
  return calWalk(d, start).entries;
}

/**
 * The activation gate's structural half: does `start` begin a table that walks
 * like a real one?
 *
 * Locating the magic is NOT enough on its own. Its first two bytes are also
 * entry 0's offset word (0x004E), so every occurrence of `4E 00 FF FF` yields
 * at least one entry — including one that lands by chance in a padding run.
 * A genuine table walks several entries and stops on its terminator.
 */
export function isCoherentCalTable(d: Uint8Array, start: number): boolean {
  const w = calWalk(d, start);
  return w.terminated && w.entries.length >= MIN_ENTRIES;
}
