import { crc16 } from '../src/crc16.js';
import { CAL_MAGIC } from '../src/ms41/cal.js';

export const FULL = 262144;
export const TUNE = 24576;

/**
 * Entry stores, as offsets from `start`. Entry 0's is fixed at 0x4E by the
 * layout — the magic's own first two bytes ARE its offset word (ss = 0x004E).
 * The rest are ours to choose; each entry covers [prevStore + 2, store), so the
 * stores must ascend with at least 2 bytes between them.
 *
 * Four entries because the activation gate requires at least that many before
 * it will call a terminating walk a real table (see MIN_ENTRIES in ms41/cal.ts).
 * A one-entry fixture is exactly the padding-run coincidence that gate rejects.
 */
const CAL_STORES = [0x4e, 0x80, 0xb0, 0xe0] as const;

/**
 * Build an MS41-shaped image with four valid cal entries and (for a full ROM) a
 * valid boot checksum. Deterministic: byte i = (i * 7) % 251, so covered regions
 * are non-uniform, a corrupted byte actually changes the CRC, and no fill byte
 * is ever 0xFF.
 *
 * Laid out like real firmware: the magic marks `start` and doubles as entry 0's
 * offset word, each checksum is stored at its entry's exclusive upper bound
 * (outside its own coverage), the next entry begins at store + 2, and the walk
 * ends on a 0xFFFF terminator — the same shape the real bins walk, at 4 entries
 * instead of their 16.
 *
 * This fixture is self-consistent BY CONSTRUCTION — it proves round-trip and
 * guards regressions, it does NOT validate the algorithm. That is the real-bin
 * cross-check's job (Task 8).
 */
export function ms41Image(size: typeof FULL | typeof TUNE): Uint8Array {
  const d = new Uint8Array(size);
  for (let i = 0; i < size; i++) d[i] = (i * 7) % 251;

  const start = size === FULL ? 0x14000 : 0x1000;
  d.set(CAL_MAGIC, start);
  d[start + 0x0e] = 0x12; // init BE hi
  d[start + 0x0f] = 0x34; // init BE lo

  // Offset words first — every one of them is inside some entry's covered range,
  // so they must all be in place before any checksum is computed over them.
  // Entry 0's word is the magic itself; the rest sit at the previous store + 2.
  for (let i = 1; i < CAL_STORES.length; i++) {
    const at = start + CAL_STORES[i - 1]! + 2;
    d[at] = CAL_STORES[i]! & 0xff;
    d[at + 1] = (CAL_STORES[i]! >>> 8) & 0xff;
  }
  const end = start + CAL_STORES[CAL_STORES.length - 1]! + 2; // terminator slot
  d[end] = 0xff;
  d[end + 1] = 0xff;

  // Now stamp each entry's checksum over its settled coverage.
  let from = start;
  for (const s of CAL_STORES) {
    const store = start + s;
    const calc = crc16(d.subarray(from, store), 0x1234);
    d[store] = calc & 0xff;
    d[store + 1] = (calc >>> 8) & 0xff;
    from = store + 2;
  }

  if (size === FULL) {
    const boot = crc16(d.subarray(0x4000, 0x5c14), 0x4711);
    d[0x5c80] = boot & 0xff;
    d[0x5c81] = (boot >>> 8) & 0xff;
    d[0x605c] = 0x30; // verification enabled
  }
  return d;
}
