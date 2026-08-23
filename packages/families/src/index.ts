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
export type { ChecksumBlock, ChecksumReport, FamilyChecksums, FamilyIdentity } from './types.js';
export { clearExternalFamilies, externalFamilies, registerExternalFamily } from './external.js';

import type { FamilyChecksums, FamilyIdentity } from './types.js';
import { ms41Checksums } from './ms41/checksums.js';
import { externalFamilies } from './external.js';

/**
 * Registry of family checksum modules, mirroring the engine's
 * FAMILY_ANALYZERS. Compile-time by design: runtime third-party loading needs
 * an API version policy, distribution and a trust model, and is a separate
 * project. Every module must be inert (applies === false) off-family, so
 * probing all of them is safe.
 */
export const FAMILY_CHECKSUMS: readonly FamilyChecksums[] = [ms41Checksums];

/**
 * The first module that recognises `bytes`, or undefined.
 *
 * BUILT-INS FIRST, then drop-in modules. A drop-in declaring `ms41` therefore
 * never shadows the shipped one — it is simply never reached, which fails
 * visibly (the Families dialog lists both) rather than silently.
 */
export function checksumsFor(bytes: Uint8Array): FamilyChecksums | undefined {
  return (
    FAMILY_CHECKSUMS.find((c) => c.applies(bytes)) ?? externalFamilies().find((c) => c.applies(bytes))
  );
}

/**
 * The image's family + calibration id, or undefined when none can be read.
 *
 * Deliberately routed through `checksumsFor`, so an id is only ever read out of
 * an image a family structurally CLAIMS. Reading the id bytes alone would
 * happily identify any buffer that happens to carry digits at the right offset,
 * and the CAL-ID gate would then be resting on a coincidence.
 */
export function identifyBin(bytes: Uint8Array): FamilyIdentity | undefined {
  return checksumsFor(bytes)?.identify(bytes);
}
