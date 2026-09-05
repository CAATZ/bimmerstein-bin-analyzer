import { readValue } from '@binanalyzer/core';
import type { ValueFormat } from '@binanalyzer/core';
import type { ScanConfig } from './config.js';
import type { Region } from './regions.js';

/**
 * Stage 3 — Table candidate scan (spec §4.3).
 * Score rectangular blocks for 2D smoothness: low total variation along rows
 * AND columns relative to their range, supported by variation across cells;
 * correct column count minimizes
 * vertical discontinuity ("jumps align at row boundaries"). This stage emits
 * 2D candidates (rows ≥ minRows); separate detectors handle curves.
 */
export interface TableCandidate {
  address: number;
  rows: number;
  cols: number;
  format: ValueFormat;
  /** 0..1 smoothness composite. */
  score: number;
  /**
   * True when this candidate came from the cluster-split pass (cluster.ts): a
   * packed same-shape sibling table framed by a periodic high-contrast
   * separator. Stage 5 admits separator-backed cluster candidates to the pool
   * tier on the pool anchor alone (the separator is the boundary evidence),
   * bypassing the start/end-edge membership that packed tables fail. Undefined
   * on ordinary scanTables candidates.
   */
  cluster?: boolean;
}

/** Derived from config.table.widths — the config field is the single knob. */
function tableFormats(config: ScanConfig): ValueFormat[] {
  const out: ValueFormat[] = [];
  for (const width of config.table.widths) {
    out.push({ width, signed: false, endianness: 'big' });
    if (width > 1) out.push({ width, signed: false, endianness: 'little' });
  }
  return out;
}

/**
 * Mean row-to-row |Δ| of an rows×cols block read directly from bytes — the
 * same column-total-variation used by scanTables, so stage 5 can probe a
 * candidate's vertical discontinuity at alternative column counts (spec §4.3
 * "correct column count minimizes vertical discontinuity"). Returns undefined
 * when the block doesn't fit or is degenerate.
 */
export function colTvAt(
  bytes: Uint8Array,
  address: number,
  rows: number,
  cols: number,
  format: ValueFormat
): number | undefined {
  const w = format.width;
  if (address < 0 || rows < 2 || cols < 1 || address + rows * cols * w > bytes.length) return undefined;
  let sum = 0;
  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const above = readValue(bytes, address + ((r - 1) * cols + c) * w, format);
      const here = readValue(bytes, address + (r * cols + c) * w, format);
      sum += Math.abs(here - above);
    }
  }
  return sum / ((rows - 1) * cols);
}

/**
 * Pre-emission edge gate (spec §4.3 feed reduction): a candidate must begin AND
 * end at a data boundary. The top/bottom edge is the mean row-to-row |Δ| between
 * the block's boundary row and the adjacent pseudo-row (computed from the decoded
 * `vals`), taken over the block's own `colTv`. An out-of-region pseudo-row counts
 * as an edge (region boundaries ARE data boundaries). Same 1e-9 divide-by-zero
 * guard as score.ts's edge gates. `emissionEdgeMin <= 0` disables the gate.
 */
function passesEdge(
  vals: Float64Array, start: number, rows: number, cols: number, n: number, colTv: number, emissionEdgeMin: number
): boolean {
  if (emissionEdgeMin <= 0) return true;
  const denom = colTv + 1e-9;
  // top: pseudo-row [start-cols, start)
  if (start - cols >= 0) {
    let s = 0;
    for (let c = 0; c < cols; c++) s += Math.abs(vals[start + c]! - vals[start - cols + c]!);
    if (s / cols / denom < emissionEdgeMin) return false;
  }
  // bottom: pseudo-row [start+rows*cols, start+(rows+1)*cols)
  const nb = start + rows * cols;
  if (nb + cols <= n) {
    let s = 0;
    for (let c = 0; c < cols; c++) s += Math.abs(vals[nb + c]! - vals[nb - cols + c]!);
    if (s / cols / denom < emissionEdgeMin) return false;
  }
  return true;
}

export function scanTables(bytes: Uint8Array, regions: Region[], config: ScanConfig): TableCandidate[] {
  const { minCols, maxCols, minRows, maxRows, colSmoothFactor, growthAbsFloor, growthRangeMultiplier, minTableScore, minVariationFraction, emissionEdgeMin } = config.table;
  const out: TableCandidate[] = [];
  for (const region of regions) {
    if (region.kind !== 'data') continue;
    for (const format of tableFormats(config)) {
      const w = format.width;
      for (let phase = 0; phase < w; phase++) {
      const base = region.start + phase;
      const n = Math.floor((region.end - base) / w);
      if (n < minCols * minRows) continue;
      const vals = new Float64Array(n);
      for (let i = 0; i < n; i++) vals[i] = readValue(bytes, base + i * w, format);

      for (let cols = minCols; cols <= maxCols; cols++) {
        let start = 0;
        while (start + cols * minRows <= n) {
          // Grow rows while consecutive rows stay similar relative to local
          // range. Running statistics are maintained INCREMENTALLY as the block
          // grows one row at a time — each added row costs O(cols), so growing
          // to R rows costs O(R×cols) total instead of the O(R²×cols) of
          // recomputing the block statistics from scratch at every step.
          // The running sums use these formulas:
          //   range   = max − min over all cells
          //   rowTv   = Σ|v[r][c]−v[r][c−1]| (c>0)   / (rows·(cols−1)), ≥1 denom
          //   colTv   = Σ|v[r][c]−v[r−1][c]| (r>0)   / ((rows−1)·cols), ≥1 denom
          //   meanColDiff(row) = Σ_j|v[row+1][j]−v[row][j]| / cols
          // The growth test at step `rows` mirrors the original exactly: it uses
          // `range` computed over rows+1 rows and `diff = meanColDiff(rows−1)`
          // (the new row vs the previous one). Because meanColDiff(rows−1) is
          // precisely the new row's colTv contribution ÷ cols, one O(cols) pass
          // over the candidate row yields both `diff` and the tentative range.
          let rows = 1;
          // Running accumulators for the currently-accepted `rows`-row block.
          let min = Infinity;
          let max = -Infinity;
          let rowTvSum = 0; // Σ within-row |Δcol| over accepted rows
          let colTvSum = 0; // Σ row-to-row |Δ| over accepted rows
          // Seed with row 0 (min/max and its internal rowTv diffs).
          {
            const base = start;
            let prev = vals[base]!;
            if (prev < min) min = prev;
            if (prev > max) max = prev;
            for (let c = 1; c < cols; c++) {
              const v = vals[base + c]!;
              if (v < min) min = v;
              if (v > max) max = v;
              rowTvSum += Math.abs(v - prev);
              prev = v;
            }
          }
          while (rows < maxRows && start + (rows + 1) * cols <= n) {
            // Evaluate candidate new row (0-indexed `rows`) in a single O(cols)
            // pass: compute its tentative min/max contribution, its own within-
            // row colTv (rowTvSum delta), and its row-to-row diff vs the
            // previous row (colTvSum delta / diff numerator).
            const rowBase = start + rows * cols;
            const prevBase = rowBase - cols;
            let candMin = min;
            let candMax = max;
            let newRowTv = 0; // this row's internal column-to-column diffs
            let newColTv = 0; // this row's diffs vs the previous row
            let prevInRow = vals[rowBase]!;
            {
              const v0 = prevInRow;
              if (v0 < candMin) candMin = v0;
              if (v0 > candMax) candMax = v0;
              newColTv += Math.abs(v0 - vals[prevBase]!);
            }
            for (let c = 1; c < cols; c++) {
              const v = vals[rowBase + c]!;
              if (v < candMin) candMin = v;
              if (v > candMax) candMax = v;
              newRowTv += Math.abs(v - prevInRow);
              newColTv += Math.abs(v - vals[prevBase + c]!);
              prevInRow = v;
            }
            // Preserve minimum-size growth; an established block's outlier
            // must not expand the range used to justify that same row.
            const candidateRange = candMax - candMin;
            const range = rows > minRows && candidateRange > growthRangeMultiplier * (max - min)
              ? max - min : candidateRange;
            const diff = newColTv / cols;
            if (diff > colSmoothFactor * (range + 1) && diff > growthAbsFloor) break;
            // Accept the row: fold its contributions into the running sums.
            min = candMin;
            max = candMax;
            rowTvSum += newRowTv;
            colTvSum += newColTv;
            rows++;
          }
          if (rows >= minRows) {
            const range = max - min;
            const rowTv = rowTvSum / Math.max(1, rows * (cols - 1));
            const colTv = colTvSum / Math.max(1, (rows - 1) * cols);
            // A few jumps in flat filler inflate the range without supporting
            // a whole surface. Variation in either direction supports a cell.
            let score = range <= 0 ? 0.1 : Math.max(0, 1 - (rowTv + colTv) / (range + 1));
            if (score >= minTableScore && passesEdge(vals, start, rows, cols, n, colTv, emissionEdgeMin)) {
              if (range > 0 && minVariationFraction > 0) {
                // Count only boundary survivors; stop once the weight is 1.
                const required = rows * cols * minVariationFraction;
                let varied = 0;
                for (let r = 0; r < rows && varied < required; r++) {
                  const row = start + r * cols;
                  for (let c = 0; c < cols; c++) {
                    const i = row + c;
                    if ((c > 0 && vals[i] !== vals[i - 1]) || (r > 0 && vals[i] !== vals[i - cols])) varied++;
                  }
                }
                score *= Math.min(1, varied / required);
              }
              if (score >= minTableScore) out.push({ address: base + start * w, rows, cols, format, score });
            }
          }
          // Always advance by a single element, whether this candidate was
          // accepted or rejected. The old behavior advanced by `cols` on
          // rejection and skipped ahead by `rows*cols` past an emitted block
          // on acceptance — both confine every `start` this loop ever tries
          // to a fixed lattice relative to the region start (multiples of
          // `cols`, or wherever a prior accepted block happened to end). A
          // true table whose start offset falls off that lattice — e.g.
          // sitting directly after an axis run of a length not divisible by
          // `cols`, as in real tightly-packed ECU cal layouts — was
          // therefore structurally unreachable no matter how
          // config.table.* was tuned.
          //
          // A version that kept the accept-side skip-ahead (only changing
          // the reject advance to 1) was tried and rejected: it can still
          // permanently hide the true table when a *different*, spuriously
          // "passing" block (e.g. a short run whose apparent smoothness is
          // inflated by a single nearby outlier) is accepted first and its
          // skip-ahead jumps over the true block's start before it is ever
          // tried. Advancing by 1 unconditionally is the only variant
          // confirmed to guarantee every start is actually probed for this
          // `cols` value, so a competing candidate's skip-ahead can never
          // permanently hide the true table. This emits many more
          // (overlapping) candidates than before; stage 5's overlap dedup
          // (score.ts) already discards the inferior overlapping ones. The
          // extra positions this probes made the O(maxRows²×cols) per-position
          // recompute untenable, which is exactly why the row-growth stats
          // above are now maintained incrementally (O(maxRows×cols) per
          // position); the per-position count is unchanged by that rewrite.
          start += 1;
        }
      }
      }
    }
  }
  return out;
}
