/**
 * CRC-16/ARC (reflected poly 0xA001) — the algorithm every MS41 checksum uses.
 * Table-driven: the whole 256 KB image is covered in single-digit milliseconds,
 * which is why verification can run synchronously on bin load.
 *
 * Pure and allocation-free per call. The table is built once at module load.
 */
const POLY = 0xa001;

/**
 * The table build below uses a two-register (`n` / `n2`) bit-serial form rather
 * than the single-register `c = c & 1 ? (c >> 1) ^ POLY : c >> 1` you will find
 * in most references. That is deliberate: it mirrors the reference
 * implementation this module was transcribed from, so the two can be diffed
 * line by line. The forms are algebraically equivalent — `n2` just carries the
 * input bits that the single-register version keeps in the low bits of `c` —
 * and the equivalence is pinned by the published CRC-16/ARC check value
 * (0xBB3D for "123456789"), which is an external constant, not a self-check.
 */

const TABLE: readonly number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    let n = 0;
    let n2 = i;
    for (let j = 0; j < 8; j++) {
      n = ((n2 ^ n) & 1) === 1 ? (n >>> 1) ^ POLY : n >>> 1;
      n2 >>>= 1;
    }
    t.push(n);
  }
  return t;
})();

/** CRC over `buf`, seeded with `init`. Chain by passing a previous result as init. */
export function crc16(buf: Uint8Array, init: number): number {
  let s = init;
  for (const b of buf) s = (s >>> 8) ^ TABLE[(s ^ b) & 0xff]!;
  return s;
}
