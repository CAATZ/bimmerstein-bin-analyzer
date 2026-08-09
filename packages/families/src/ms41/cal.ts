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

/**
 * Walk the cal checksum table. Each entry is a u16-LE offset RELATIVE TO
 * `start`, read at the current `pos`; it names where that entry's checksum
 * lives. The covered range is [pos, store) and the next entry begins at
 * store + 2. The walk stops on a 0xFFFF offset, on a store that would run past
 * the buffer, or on one that moves backwards.
 */
export function calEntries(d: Uint8Array, start: number): CalEntry[] {
  const out: CalEntry[] = [];
  if (start < 0 || start + 0x10 > d.length) return out;
  const init = be16(d, start + 0x0e);
  let pos = start;
  for (let i = 0; i < MAX_ENTRIES; i++) {
    const ss = u16le(d, pos);
    if (ss === 0xffff) break;
    const store = start + ss;
    if (store + 2 > d.length || store < pos) break;
    out.push({ store, from: pos, calc: crc16(d.subarray(pos, store), init) });
    pos = store + 2;
  }
  return out;
}
