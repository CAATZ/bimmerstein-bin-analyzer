export * from './crc16.js';
export * from './bytes.js';
export * from './types.js';
export * from './ms41/cal.js';
export { ms41Checksums, FULL_ROM_SIZE, TUNE_SIZE } from './ms41/checksums.js';

import type { FamilyChecksums } from './types.js';
import { ms41Checksums } from './ms41/checksums.js';

/**
 * Registry of family checksum modules, mirroring the engine's
 * FAMILY_ANALYZERS. Compile-time by design: runtime third-party loading needs
 * an API version policy, distribution and a trust model, and is a separate
 * project. Every module must be inert (applies === false) off-family, so
 * probing all of them is safe.
 */
export const FAMILY_CHECKSUMS: readonly FamilyChecksums[] = [ms41Checksums];

/** The first module that recognises `bytes`, or undefined. */
export function checksumsFor(bytes: Uint8Array): FamilyChecksums | undefined {
  return FAMILY_CHECKSUMS.find((c) => c.applies(bytes));
}
