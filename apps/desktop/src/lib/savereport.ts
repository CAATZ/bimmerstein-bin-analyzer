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
  /** As above, but `bytes` edited bytes fall inside a checksum this tool will not recompute. */
  | { kind: 'covered-by-uncorrected'; checksumId: string; bytes: number }
  /** No family module ever recognised this image; bytes were written verbatim. */
  | { kind: 'unrecognised' }
  /** A module was active at load but no longer recognises the edited image — an edit hit structural bytes. */
  | { kind: 'structure-changed' }
  /** Correction ran and the result still does not verify. An internal inconsistency, not a user error. */
  | { kind: 'invalid-after-correction'; mismatched: number };

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
  if (!report.valid) {
    return { kind: 'invalid-after-correction', mismatched: report.blocks.filter((b) => !b.ok).length };
  }
  for (const s of report.skipped) {
    const ranges = s.covers;
    if (ranges === undefined || ranges.length === 0) continue;
    const bytes = editedOffsets.filter((o) => covered(o, ranges)).length;
    if (bytes > 0) return { kind: 'covered-by-uncorrected', checksumId: s.id, bytes };
  }
  return { kind: 'corrected' };
}

export function verdictHeadline(v: SaveVerdict): string {
  switch (v.kind) {
    case 'corrected':
      return 'Checksums corrected and verified on disk.';
    case 'covered-by-uncorrected':
      return `Checksums corrected, but ${v.bytes} edited byte(s) fall inside the "${v.checksumId}" checksum, which this tool does not recompute.`;
    case 'unrecognised':
      return 'Written verbatim — NOT checksum-corrected. No family module recognises this image.';
    case 'structure-changed':
      return 'NOT checksum-corrected — the family module no longer recognises this image, so an edit reached bytes its structure depends on.';
    case 'invalid-after-correction':
      return `Correction ran and ${v.mismatched} checksum(s) still do not match. Do not flash this file.`;
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
