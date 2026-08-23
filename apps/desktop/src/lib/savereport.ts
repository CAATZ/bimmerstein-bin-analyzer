import type { ChecksumReport } from '@binanalyzer/families';

/**
 * What a save did, and what it deliberately did not do (spec
 * 2026-08-11-binary-write-path §5). PURE — no stores, no host, no Svelte: the
 * verdict is the one piece of save logic worth testing in isolation, because it
 * is the sentence the user reads before flashing.
 */
export type SaveVerdict =
  /** A module recognised the image, everything it stands behind is valid, and the edits touch nothing it declines to correct. */
  | { kind: 'corrected' }
  /**
   * As above, but `coveredBytes` of the user's edited bytes fall inside a
   * checksum this tool will not recompute. Deliberately NOT named `bytes`: the
   * repo-wide guard that stops a view reading the ORIGINAL buffer scans for a
   * bare byte-array property access, and an unrelated field spelled that way
   * would force the guard to be loosened. Renaming here keeps it absolute.
   */
  | { kind: 'covered-by-uncorrected'; checksumId: string; coveredBytes: number }
  /** No family module ever recognised this image; bytes were written verbatim. */
  | { kind: 'unrecognised' }
  /** A module was active at load but no longer recognises the edited image — an edit hit structural bytes. */
  | { kind: 'structure-changed' }
  /** Correction ran and the result still does not verify. An internal inconsistency, not a user error. */
  | { kind: 'invalid-after-correction'; mismatched: number }
  /**
   * A checksum this tool never writes is mismatched, and the user's edits did
   * NOT touch it — the image arrived that way. Distinct from
   * `covered-by-uncorrected` (you caused it) and from
   * `invalid-after-correction` (we did): three situations, three responses.
   */
  | { kind: 'uncorrectable-mismatch'; checksumId: string };

export interface SaveSuccess {
  ok: true;
  path: string;
  name: string;
  size: number;
  /** sha256 READ BACK from the file on disk — a measurement, not an intention. */
  sha256: string;
  verdict: SaveVerdict;
  corrected: { offset: number; from: number; to: number }[];
  report: ChecksumReport | undefined;
  /** Journal size BEFORE the correction: the user's own edits, not ours. */
  editedBytes: number;
}

export interface SaveFailure {
  ok: false;
  /** The target, when one had been chosen; null when the failure came earlier. */
  path: string | null;
  reason: string;
}

export type SaveOutcome = SaveSuccess | SaveFailure;

const covered = (offset: number, ranges: { start: number; end: number }[]): boolean =>
  ranges.some((r) => offset >= r.start && offset < r.end);

/**
 * `editedOffsets` is the journal as it stood BEFORE the correction was applied.
 * The correction's own bytes are this tool's writes, not the user's, and
 * counting them would turn "your edits touch it" into a claim about ourselves.
 */
export function saveVerdict(args: {
  report: ChecksumReport | undefined;
  editedOffsets: readonly number[];
}): SaveVerdict {
  const { report, editedOffsets } = args;
  if (report === undefined) return { kind: 'unrecognised' };
  if (!report.applies) return { kind: 'structure-changed' };
  // Deliberately NOT keyed on `report.valid`. `valid` spans blocks we never
  // write, so a stale one would otherwise be reported as OUR correction having
  // failed — three different situations that need three different answers.
  const bad = report.blocks.filter((b) => !b.ok);
  const badCorrectable = bad.filter((b) => b.correctable);
  if (badCorrectable.length > 0) {
    return { kind: 'invalid-after-correction', mismatched: badCorrectable.length };
  }
  // A checksum we never write, whose region the user's edits landed in.
  for (const b of bad.filter((x) => !x.correctable)) {
    const bytes = editedOffsets.filter((o) => covered(o, b.covers)).length;
    if (bytes > 0) return { kind: 'covered-by-uncorrected', checksumId: b.id, coveredBytes: bytes };
  }
  // Stale, ours to report but not to fix, and not the user's doing.
  const stale = bad.find((b) => !b.correctable);
  if (stale !== undefined) return { kind: 'uncorrectable-mismatch', checksumId: stale.id };
  return { kind: 'corrected' };
}

export function verdictHeadline(v: SaveVerdict): string {
  switch (v.kind) {
    case 'corrected':
      return 'Checksums corrected and verified on disk.';
    case 'covered-by-uncorrected':
      return `Checksums corrected, but ${v.coveredBytes} edited byte(s) fall inside the "${v.checksumId}" checksum, which this tool does not recompute.`;
    case 'unrecognised':
      return 'Written verbatim — NOT checksum-corrected. No family module recognises this image.';
    case 'structure-changed':
      return 'NOT checksum-corrected — the family module no longer recognises this image, so an edit reached bytes its structure depends on.';
    case 'invalid-after-correction':
      return `Correction ran and ${v.mismatched} checksum(s) still do not match. Do not flash this file.`;
    case 'uncorrectable-mismatch':
      return `Saved. The "${v.checksumId}" checksum was already mismatched in this image, and this tool does not write it.`;
  }
}

/**
 * A clean correction reports by toast; everything else interrupts. Toasts
 * auto-dismiss after six seconds, which is the wrong treatment for a file the
 * user may flash — and a modal that only ever appears when something is wrong
 * keeps its meaning.
 */
export function isModalOutcome(o: SaveOutcome): boolean {
  return !o.ok || o.verdict.kind !== 'corrected';
}
