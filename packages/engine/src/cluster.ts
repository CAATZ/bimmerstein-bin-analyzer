import type { ValueFormat } from '@binanalyzer/core';
import type { ScanConfig } from './config.js';
import type { Region } from './regions.js';
import type { TableCandidate } from './tables.js';

/**
 * Stage 3b — cluster-split candidate generation (spec §4.3, stage-3 addendum).
 * Packed same-shape sibling tables (the MS41 knock cluster: ten 16×4 u8 tables
 * at a 68-byte stride separated by high-contrast bytes) are swallowed by the
 * stage-3 row-growth scanner as one big smooth block, so their exact framings
 * never enter the candidate pool. This pass finds a run of >= minReps
 * high-contrast "separator" byte-runs spaced at a consistent stride and emits
 * the aligned sub-blocks between them as extra u8 candidates (cluster: true).
 * Deterministic and pure; every threshold is a config.cluster field.
 */
const U8: ValueFormat = { width: 1, signed: false, endianness: 'big' };

/**
 * u8-block 2D smoothness — the same 1 − (rowTv + colTv)/(range + 1) composite
 * scanTables emits, computed directly on bytes for a width-1 block. Local to
 * cluster.ts so it stays off the tables.ts hot path.
 */
function clusterBlockScore(bytes: Uint8Array, addr: number, rows: number, cols: number): number {
  let min = Infinity;
  let max = -Infinity;
  let rowTv = 0;
  let colTv = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const v = bytes[addr + r * cols + c]!;
      if (v < min) min = v;
      if (v > max) max = v;
      if (c > 0) rowTv += Math.abs(v - bytes[addr + r * cols + c - 1]!);
      if (r > 0) colTv += Math.abs(v - bytes[addr + (r - 1) * cols + c]!);
    }
  const range = max - min;
  const rTv = rowTv / Math.max(1, rows * (cols - 1));
  const cTv = colTv / Math.max(1, (rows - 1) * cols);
  return range <= 0 ? 0.1 : Math.max(0, 1 - (rTv + cTv) / (range + 1));
}

export function detectClusterCandidates(
  bytes: Uint8Array,
  regions: Region[],
  config: ScanConfig
): TableCandidate[] {
  const { jumpMin, strideMin, strideMax, minReps, strideTol, sepLenMax, minSubRows, colSearchMax } = config.cluster;
  const { minCols, maxCols, maxRows, minTableScore } = config.table;
  const out: TableCandidate[] = [];
  for (const region of regions) {
    if (region.kind !== 'data') continue;
    // 1) locate high-contrast separator runs (|Δ| >= jumpMin between adjacent bytes)
    const bounds: Array<{ sepStart: number; sepLen: number; dataResume: number }> = [];
    let i = region.start + 1;
    while (i < region.end) {
      if (Math.abs(bytes[i]! - bytes[i - 1]!) >= jumpMin) {
        const sepStart = i;
        let j = i;
        while (j < region.end && Math.abs(bytes[j]! - bytes[j - 1]!) >= jumpMin) j++;
        bounds.push({ sepStart, sepLen: j - sepStart, dataResume: j });
        i = j;
      } else i++;
    }
    if (bounds.length < minReps) continue;
    // 2) find maximal runs of separators at a consistent stride
    let a = 0;
    while (a < bounds.length - 1) {
      const stride0 = bounds[a + 1]!.sepStart - bounds[a]!.sepStart;
      if (stride0 < strideMin || stride0 > strideMax) {
        a++;
        continue;
      }
      let b = a + 1;
      while (b < bounds.length - 1 && Math.abs(bounds[b + 1]!.sepStart - bounds[b]!.sepStart - stride0) <= strideTol) b++;
      if (b - a + 1 >= minReps) {
        // 3) emit the sub-block after each separator in the run
        for (let k = a; k <= b; k++) {
          const start = bounds[k]!.dataResume;
          const sepLen = bounds[k]!.sepLen;
          const end = k < b ? bounds[k + 1]!.sepStart : Math.min(bounds[k]!.sepStart + stride0 - sepLen, region.end);
          const L = end - start;
          if (L < minSubRows) continue;
          // column count: the separator width when it plausibly equals cols,
          // else the smallest divisor of L that yields a valid block.
          const colChoices: number[] = [];
          if (sepLen >= minCols && sepLen <= sepLenMax && L % sepLen === 0) colChoices.push(sepLen);
          if (colChoices.length === 0)
            for (let c = minCols; c <= Math.min(maxCols, colSearchMax); c++)
              if (L % c === 0 && L / c >= minSubRows && L / c <= maxRows) {
                colChoices.push(c);
                break;
              }
          for (const cols of colChoices) {
            const rows = L / cols;
            if (rows < minSubRows || rows > maxRows || cols > maxCols) continue;
            if (start + rows * cols > region.end) continue;
            const score = clusterBlockScore(bytes, start, rows, cols);
            if (score < minTableScore) continue;
            out.push({ address: start, rows, cols, format: U8, score, cluster: true });
          }
        }
      }
      a = b;
    }
  }
  return out;
}
