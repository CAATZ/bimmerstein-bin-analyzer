export const u16le = (d: Uint8Array, a: number): number => d[a]! | (d[a + 1]! << 8);
export const be16 = (d: Uint8Array, a: number): number => (d[a]! << 8) | d[a + 1]!;

/**
 * Scan DOWN from `anchor` while bytes are 0xFF; return the first kept index
 * (i.e. an EXCLUSIVE end offset). Erased flash tails are excluded from every
 * MS41 program CRC. Each program region has its own anchor and they are NOT
 * interchangeable — see ms41/checksums.ts.
 */
export function trimEnd(d: Uint8Array, anchor: number): number {
  let i = anchor;
  while (i > 0 && d[i] === 0xff) i--;
  return i + 1;
}
