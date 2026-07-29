import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BinImage } from './types.js';

export function createBinImage(bytes: Uint8Array, name: string): BinImage {
  return { bytes, name, size: bytes.length, sha256: bytesToHex(sha256(bytes)) };
}
