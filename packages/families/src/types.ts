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
  /** Checksums deliberately NOT evaluated, each with a reason. */
  skipped: { id: string; reason: string }[];
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
    changed: { offset: number; from: number; to: number }[];
  };
}
