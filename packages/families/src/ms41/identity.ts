import type { FamilyIdentity } from '../types.js';
import { FULL_ROM_SIZE, TUNE_SIZE } from './cal.js';

/**
 * The romid string the ECU carries: 12 ASCII digits, at 0x1400E on a 256 KB
 * full read and at 0xE on a 24 KB calibration partial — the same field, seen
 * through the two windows the family reads.
 *
 * Measured on real firmware: "120111100900" (E36 M3 / MS41.2, and the SS1v2
 * image, which is built on the ID12 base and so carries the same id) and
 * "410111100600" (1429861 / MS41.0). A definition's rom xmlid uses exactly the
 * leading field of these.
 */
const ID_LEN = 12;

/**
 * Keyed on SIZE, deliberately not a fallback chain. A full read whose romid
 * slot is empty must stay unidentified rather than scavenge whatever digits
 * happen to sit at the partial's offset — a wrong CAL-ID would defeat the very
 * gate this exists to feed.
 */
const OFFSETS = new Map<number, number>([
  [FULL_ROM_SIZE, 0x1400e],
  [TUNE_SIZE, 0x0e],
]);

/** The 12 id bytes as a string, or undefined if any of them is not a digit. */
const digitsAt = (bytes: Uint8Array, at: number): string | undefined => {
  if (at + ID_LEN > bytes.length) return undefined;
  let s = '';
  for (let i = at; i < at + ID_LEN; i++) {
    const c = bytes[i]!;
    if (c < 0x30 || c > 0x39) return undefined; // digits only — no guessing
    s += String.fromCharCode(c);
  }
  return s;
};

/** "120111100900" -> "12"; "410111100600" -> "41". */
const calIdOf = (romid: string): string | undefined => /^([1-9][0-9]?)0/.exec(romid)?.[1];

export function ms41Identify(bytes: Uint8Array): FamilyIdentity | undefined {
  const at = OFFSETS.get(bytes.length);
  if (at === undefined) return undefined;
  const romid = digitsAt(bytes, at);
  if (romid === undefined) return undefined;
  const calId = calIdOf(romid);
  return calId === undefined ? undefined : { familyId: 'ms41', calId };
}
