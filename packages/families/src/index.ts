/**
 * The package's public surface, listed rather than re-exported wholesale.
 *
 * Consumers need the capability contract, the registry, and the two byte
 * primitives an app needs to construct or reason about an MS41 image. The walk
 * internals (findCalTable, calWalk, calEntries, isCoherentCalTable, the byte
 * readers, the size constants) stay module-private so Part B's write path
 * cannot quietly couple to them — when it needs one, exporting it should be a
 * deliberate decision with a reason, not an accident of `export *`.
 */
export { crc16 } from './crc16.js';
export { CAL_MAGIC } from './ms41/cal.js';
export type { ChecksumBlock, ChecksumReport, FamilyChecksums } from './types.js';

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
