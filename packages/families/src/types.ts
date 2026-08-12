import type { FamilyId } from '@binanalyzer/core';

/** One checksum the family module stands behind. */
export interface ChecksumBlock {
  /** Stable id, e.g. 'boot', 'cal-0'. */
  id: string;
  /** Human label for the UI. */
  label: string;
  /** FILE offsets covered by this checksum (end exclusive). */
  covers: { start: number; end: number };
  /** FILE offset where the stored value lives. */
  storedAt: number;
  stored: number;
  computed: number;
  ok: boolean;
}

export interface ChecksumReport {
  familyId: FamilyId;
  /** false ⇒ this module does not recognise the image; `blocks` is empty. */
  applies: boolean;
  blocks: ChecksumBlock[];
  /** true when every block is ok AND at least one block was evaluated. */
  valid: boolean;
  /**
   * Checksums deliberately NOT evaluated, each with a reason — and, when the
   * checksum exists in this image but is not vouched for, the FILE ranges it
   * covers. A consumer needs those to answer "do my edits touch it?"; a
   * checksum that is simply ABSENT from the image (boot, in a 24 KB partial)
   * carries none, because there is nothing to touch.
   */
  skipped: { id: string; reason: string; covers?: { start: number; end: number }[] }[];
  /** Advisory facts that change what a result MEANS, not whether it passes. */
  notes: string[];
}

/**
 * A family's byte semantics. Registered at compile time; shaped as a future
 * public contract so runtime loading is a later, separate step.
 */
export interface FamilyChecksums {
  familyId: FamilyId;
  /** Cheap structural gate — mirrors the analyzers' off-family rule. */
  applies(bytes: Uint8Array): boolean;
  verify(bytes: Uint8Array): ChecksumReport;
  /** Pure: returns a NEW buffer, never mutates the input. */
  correct(bytes: Uint8Array): {
    bytes: Uint8Array;
    report: ChecksumReport;
    /** Structural: always report what was altered — a data guarantee, not a UI convenience a later refactor may drop. */
    changed: { offset: number; from: number; to: number }[];
  };
}
