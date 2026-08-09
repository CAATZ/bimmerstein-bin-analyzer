import { crc16 } from '../src/crc16.js';
import { CAL_MAGIC } from '../src/ms41/cal.js';

export const FULL = 262144;
export const TUNE = 24576;

/**
 * Build an MS41-shaped image with a single valid cal entry and (for a full ROM)
 * a valid boot checksum. Deterministic: byte i = (i * 7) % 251, so covered
 * regions are non-uniform, a corrupted byte actually changes the CRC, and no
 * fill byte is ever 0xFF.
 *
 * Laid out like real firmware: the magic marks `start` and its first two bytes
 * ARE entry 0's offset word (ss = 0x004E), so entry 0 covers
 * [start, start + 0x4E), its checksum is stored at start + 0x4E (outside its own
 * coverage), and the walk reads the terminator at start + 0x50.
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
  d[start + 0x50] = 0xff; // terminator
  d[start + 0x51] = 0xff;
  // stamp the correct cal checksum for entry 0
  const calc = crc16(d.subarray(start, start + 0x4e), 0x1234);
  d[start + 0x4e] = calc & 0xff;
  d[start + 0x4f] = (calc >>> 8) & 0xff;

  if (size === FULL) {
    const boot = crc16(d.subarray(0x4000, 0x5c14), 0x4711);
    d[0x5c80] = boot & 0xff;
    d[0x5c81] = (boot >>> 8) & 0xff;
    d[0x605c] = 0x30; // verification enabled
  }
  return d;
}
