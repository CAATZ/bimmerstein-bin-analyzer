import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BinImage } from './types.js';

/** Lowercase hex sha256. The identity of a buffer of bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function createBinImage(bytes: Uint8Array, name: string): BinImage {
  return { bytes, name, size: bytes.length, sha256: sha256Hex(bytes) };
}
