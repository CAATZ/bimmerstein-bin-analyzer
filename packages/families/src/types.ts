/** One checksum the family module stands behind. */
export interface ChecksumBlock {
  /** Stable id, e.g. 'boot', 'cal-0'. */
  id: string;
  /** Human label for the UI. */
  label: string;
  /**
   * FILE offsets covered by this checksum (end exclusive).
   *
   * An ARRAY because a checksum may cover DISJOINT regions — the MS41 program
   * checksum covers three. A single range was never the general shape, and
   * `skipped` already used a list for the same data.
   */
  covers: { start: number; end: number }[];
  /** FILE offset where the stored value lives. */
  storedAt: number;
  stored: number;
  computed: number;
  ok: boolean;
  /**
   * Will `correct()` write this block's stored value?
   *
   * A block we verify but never write is still a block — it just is not ours to
   * fix. This is the difference between "your image is wrong" and "we broke
   * it", and the save verdict depends on telling those apart: a mismatch we
   * cannot fix must never be reported as our correction having failed.
   */
  correctable: boolean;
}

export interface ChecksumReport {
  /**
   * Which family this is. A plain string, not core's `FamilyId` union: a
   * DROP-IN module declares an id this build never heard of, and `FAMILY_IDS`
   * lists what SHIPS, not what may exist. The union still drives the drift
   * check for the BUILT-IN registry — see index.ts and registry.test.ts.
   *
   * Mirrors `MapPack.source.familyId`, a string for the same reason.
   */
  familyId: string;
  /** false ⇒ this module does not recognise the image; `blocks` is empty. */
  applies: boolean;
  blocks: ChecksumBlock[];
  /**
   * true when every block is ok AND at least one block was evaluated.
   *
   * Ranges over NON-CORRECTABLE blocks too, deliberately: an image carrying a
   * stale checksum we never write is not a valid image, and saying otherwise
   * would hide a real defect behind a green chip. The save verdict does NOT key
   * on this — see lib/savereport.ts, which distinguishes "we broke it" from
   * "it came that way".
   */
  valid: boolean;
  /**
   * Checksums this image does not contain, each with a reason — boot in a 24 KB
   * partial, for instance.
   *
   * ABSENT, not merely unwritten: a checksum we compute but never write is a
   * BLOCK with `correctable: false`, because it has real ranges and real
   * stored/computed values. An absent one has nothing to cover and nothing to
   * measure, which is why this entry carries neither.
   */
  skipped: { id: string; reason: string }[];
  /** Advisory facts that change what a result MEANS, not whether it passes. */
  notes: string[];
}

/** Which family a buffer belongs to, and which calibration within it. */
export interface FamilyIdentity {
  /**
   * Which family this is. A plain string, not core's `FamilyId` union: a
   * DROP-IN module declares an id this build never heard of, and `FAMILY_IDS`
   * lists what SHIPS, not what may exist. The union still drives the drift
   * check for the BUILT-IN registry — see index.ts and registry.test.ts.
   *
   * Mirrors `MapPack.source.familyId`, a string for the same reason.
   */
  familyId: string;
  /** The ECU's own calibration id, read from the image — never user-entered. */
  calId: string;
}

/**
 * A family's byte semantics. Registered at compile time; shaped as a future
 * public contract so runtime loading is a later, separate step.
 */
export interface FamilyChecksums {
  /**
   * Which family this is. A plain string, not core's `FamilyId` union: a
   * DROP-IN module declares an id this build never heard of, and `FAMILY_IDS`
   * lists what SHIPS, not what may exist. The union still drives the drift
   * check for the BUILT-IN registry — see index.ts and registry.test.ts.
   *
   * Mirrors `MapPack.source.familyId`, a string for the same reason.
   */
  familyId: string;
  /** Cheap structural gate — mirrors the analyzers' off-family rule. */
  applies(bytes: Uint8Array): boolean;
  /**
   * The image's calibration id, or undefined when it cannot be read.
   * Undefined means "I do not know" — never a guess: a map pack applied on an
   * unverified id is exactly what the CAL-ID gate exists to prevent.
   */
  identify(bytes: Uint8Array): FamilyIdentity | undefined;
  verify(bytes: Uint8Array): ChecksumReport;
  /** Pure: returns a NEW buffer, never mutates the input. */
  correct(bytes: Uint8Array): {
    bytes: Uint8Array;
    report: ChecksumReport;
    /** Structural: always report what was altered — a data guarantee, not a UI convenience a later refactor may drop. */
    changed: { offset: number; from: number; to: number }[];
  };
}
