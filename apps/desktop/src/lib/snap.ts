import { DEFAULT_SCAN_CONFIG, scanTables } from '@binanalyzer/engine';
import type { ScanConfig } from '@binanalyzer/engine';
import type { ValueFormat } from '@binanalyzer/core';

/**
 * Selection assist (spec §7 "support map selection"): run the engine's OWN
 * stage-3 table scanner over the selected byte range and adopt its best
 * framing (column count + start phase). This is literally "engine scoring of
 * the selected range" — column-count bounds and scoring all come from
 * DEFAULT_SCAN_CONFIG, so no detection heuristics live outside
 * packages/engine/src/config.ts.
 */

export interface SnapResult {
  start: number;
  end: number;
  cols: number;
}

/**
 * UI responsiveness bound, NOT a detection heuristic: snapping runs on the
 * mouse-up path; past this size the stage-3 sweep would add visible latency,
 * so bigger selections just stay as dragged.
 */
const SNAP_MAX_BYTES = 65536;

export function snapSelection(
  bytes: Uint8Array,
  start: number,
  end: number,
  format: ValueFormat
): SnapResult | null {
  const from = Math.max(0, start);
  const to = Math.min(end, bytes.length);
  const len = to - from;
  const w = format.width;
  const { minRows, minCols } = DEFAULT_SCAN_CONFIG.table;
  if (len < minRows * minCols * w || len > SNAP_MAX_BYTES) return null;
  // Copy the slice so candidate addresses are selection-relative.
  const slice = bytes.slice(from, to);
  const config: ScanConfig = {
    ...DEFAULT_SCAN_CONFIG,
    table: { ...DEFAULT_SCAN_CONFIG.table, widths: [w] },
  };
  const candidates = scanTables(slice, [{ start: 0, end: len, kind: 'data' }], config);
  let best: SnapResult | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    if (c.format.width !== w) continue;
    if (c.address >= c.cols * w) continue; // must start within the first candidate row
    if (c.score > bestScore) {
      bestScore = c.score;
      best = {
        start: from + c.address,
        end: Math.min(to, from + c.address + c.rows * c.cols * w),
        cols: c.cols,
      };
    }
  }
  return best;
}
