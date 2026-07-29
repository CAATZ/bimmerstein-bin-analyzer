import { readValue } from '@binanalyzer/core';
import type { ValueFormat } from '@binanalyzer/core';
import type { ScanConfig } from './config.js';
import type { Region } from './regions.js';

/**
 * Stage 2b — count-prefixed axis-pool scan (spec §4.4, addendum 2).
 * Siemens MS4x cal layouts store axes as [n][n monotone cells] in shared
 * pools referenced from code, NOT adjacent to their tables (measured MS41:
 * 64/64 truth axes count-prefixed; axis→table distance up to ~2.3 KB;
 * fan-out up to 18 tables per axis). This scanner finds those structures.
 * Deterministic and pure like every stage.
 */
export interface PrefixedAxis {
  /** address of the first CELL (the count prefix sits immediately before). */
  address: number;
  count: number;
  format: ValueFormat;
  /** address one past the last cell. */
  end: number;
  /**
   * true when the monotone trend BREAKS at cell n (the run is exactly the
   * declared length). Spurious window-hits usually keep ascending; measured
   * to be a load-bearing precision filter for pool binding.
   */
  maximal: boolean;
}

export function scanPrefixedAxes(bytes: Uint8Array, regions: Region[], config: ScanConfig): PrefixedAxis[] {
  const { minCount, maxCount } = config.axis;
  const out: PrefixedAxis[] = [];
  const read = (off: number, f: ValueFormat): number =>
    f.width === 1
      ? bytes[off]!
      : f.endianness === 'little'
        ? bytes[off]! | (bytes[off + 1]! << 8)
        : (bytes[off]! << 8) | bytes[off + 1]!;
  for (const region of regions) {
    if (region.kind !== 'data') continue;
    for (const f of config.pool.prefixFormats) {
      const w = f.width;
      for (let off = region.start; off + w <= region.end; off++) {
        const n = read(off, f);
        if (n < minCount || n > maxCount) continue;
        const start = off + w;
        if (start + n * w > region.end) continue;
        let dir = 0;
        let ok = true;
        let prev = read(start, f);
        for (let i = 1; i < n; i++) {
          const v = read(start + i * w, f);
          const d = Math.sign(v - prev);
          if (d === 0) {
            ok = false;
            break;
          }
          if (dir === 0) dir = d;
          else if (d !== dir) {
            ok = false;
            break;
          }
          prev = v;
        }
        if (!ok) continue;
        let maximal = true;
        if (start + (n + 1) * w <= region.end) {
          const next = read(start + n * w, f);
          if (Math.sign(next - prev) === dir) maximal = false;
        }
        out.push({ address: start, count: n, format: f, end: start + n * w, maximal });
      }
    }
  }
  // Nested-alias subsumption: an axis whose first cell value equals (count−1)
  // spawns a phantom hit one cell in ([16][15,v2..] → [15][v2..] — observed on
  // the real knock RPM axis). Drop hit B when a same-width hit A contains B's
  // span INCLUDING B's prefix cell.
  out.sort((a, b) => a.address - b.address || b.end - a.end);
  const kept: PrefixedAxis[] = [];
  for (const b of out) {
    const bPrefix = b.address - b.format.width;
    const nested = kept.some(
      (a) => a.format.width === b.format.width && a.address <= bPrefix && a.address < b.address && b.end <= a.end
    );
    if (!nested) kept.push(b);
  }
  return kept;
}

/** Pool-layout activation signature (spec §4.4 addendum 2): true once enough maximal prefixed axes exist to trust pool binding over byte-adjacency. */
export function isPoolActive(prefixed: PrefixedAxis[], config: ScanConfig): boolean {
  return prefixed.filter((p) => p.maximal).length >= config.pool.activateMinCount;
}

export interface PoolAnchor {
  x: PrefixedAxis;
  y: PrefixedAxis;
}

export interface PoolIndex {
  /** count -> maximal-and-all hits sorted by end asc (binary-searchable). */
  byCount: Map<number, PrefixedAxis[]>;
  byCountEnds: Map<number, number[]>;
}

export function buildPoolIndex(pool: PrefixedAxis[]): PoolIndex {
  const byCount = new Map<number, PrefixedAxis[]>();
  for (const p of pool) {
    const arr = byCount.get(p.count) ?? [];
    arr.push(p);
    byCount.set(p.count, arr);
  }
  const byCountEnds = new Map<number, number[]>();
  for (const [c, arr] of byCount) {
    arr.sort((a, b) => a.end - b.end || a.address - b.address);
    byCountEnds.set(c, arr.map((p) => p.end));
  }
  return { byCount, byCountEnds };
}

/** First index with ends[i] > v. */
function poolUpperBound(ends: number[], v: number): number {
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Shared-axis pool binding (spec §4.4, addendum 2): the nearest preceding
 * PAIR of MAXIMAL prefixed axes with x.count == cols and y.count == rows,
 * whose members lie within config.pool.pairSpan bytes of each other, searched
 * within config.pool.window bytes before the table start. Pair-only by
 * design — a lone count-match manufactures anchors (measured: the
 * nearest-per-count fallback was never part of a winning variant). Axes may
 * serve MANY tables (fan-out 18 measured) — no exclusivity.
 */
export function findPoolAnchor(
  table: { address: number; rows: number; cols: number },
  pidx: PoolIndex,
  config: ScanConfig
): PoolAnchor | undefined {
  const { rows, cols, address: tableStart } = table;
  const { window, pairSpan } = config.pool;
  const candidates = (count: number): PrefixedAxis[] => {
    const arr = pidx.byCount.get(count);
    if (!arr) return [];
    const ends = pidx.byCountEnds.get(count)!;
    const out: PrefixedAxis[] = [];
    for (let i = poolUpperBound(ends, tableStart) - 1; i >= 0; i--) {
      if (tableStart - ends[i]! > window) break;
      if (arr[i]!.maximal) out.push(arr[i]!); // nearest-first
    }
    return out;
  };
  const xs = candidates(cols);
  const ys = candidates(rows);
  let best: PoolAnchor | undefined;
  let bestGap = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      if (x.address === y.address) continue;
      const span = Math.max(x.address, y.address) - Math.min(x.end, y.end);
      if (span > pairSpan) continue;
      const gap = tableStart - Math.max(x.end, y.end);
      if (gap < bestGap) {
        best = { x, y };
        bestGap = gap;
      }
    }
  }
  return best;
}

/**
 * A table placed by adjacency-tight structural inference (see
 * `poolAdjacentTables`): its start, dims, and axes come from a count-prefixed
 * axis pair, not from byte-smoothness. Carries its own axes so stage 5 needs no
 * separate binding.
 */
export interface PoolStructTable {
  address: number;
  rows: number;
  cols: number;
  format: ValueFormat;
  /** Column axis — the one immediately preceding the table. */
  xAxis: PrefixedAxis;
  /** Row axis — immediately preceding the column axis. */
  yAxis: PrefixedAxis;
}

/**
 * Adjacency-tight structural table placement (spec §4.4 addendum). In the
 * tightly-packed cal layout `[rowAxis][colAxis][table]`, a count-prefixed
 * row-axis's last cell ends exactly at the col-axis's own count-prefix byte,
 * and the table begins at the col-axis end with dims rowAxis.count ×
 * colAxis.count. Because this is derived from the STORED axis lengths (the
 * count prefixes), it pins a dead/UNIFORM table's exact start + dims where the
 * stage-3 smoothness scorer cannot: a uniform block scores the range-0 floor
 * (0.1) and is gated out, so the only surviving byte candidate is a boundary-
 * clipping misframe shifted by ≥1 (measured on real MS41 24KB cal partials).
 *
 * Two precision guards keep this from firing spuriously:
 *  - TERMINAL only: the table start must not itself be another axis's count-
 *    prefix, else a tight axis CHAIN [a1][a2][a3][table] would emit a phantom
 *    table at every intermediate axis.
 *  - UNIFORM only: the placed region's decoded-cell range must be
 *    <= config.pool.structUniformMaxRange (0 = dead tables only — the sole case
 *    byte-smoothness cannot frame). Non-uniform tables are left to the byte
 *    scanner, so no real map is displaced.
 *
 * Deterministic and pure. Callers gate generation on `isPoolActive`.
 */
export function poolAdjacentTables(
  bytes: Uint8Array,
  prefixed: PrefixedAxis[],
  config: ScanConfig
): PoolStructTable[] {
  const prefixAddrs = new Set<number>();
  for (const a of prefixed) prefixAddrs.add(a.address - a.format.width);
  const out: PoolStructTable[] = [];
  for (const colAxis of prefixed) {
    const prefixAddr = colAxis.address - colAxis.format.width;
    for (const rowAxis of prefixed) {
      if (rowAxis.end !== prefixAddr) continue;
      if (rowAxis.format.width !== colAxis.format.width) continue;
      if (rowAxis.address === colAxis.address) continue;
      const address = colAxis.end;
      if (prefixAddrs.has(address)) continue; // not terminal — table start is another axis's prefix
      const w = colAxis.format.width;
      const rows = rowAxis.count;
      const cols = colAxis.count;
      if (address + rows * cols * w > bytes.length) continue;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < rows * cols; i++) {
        const v = readValue(bytes, address + i * w, colAxis.format);
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max - min > config.pool.structUniformMaxRange) continue;
      out.push({ address, rows, cols, format: colAxis.format, xAxis: colAxis, yAxis: rowAxis });
    }
  }
  return out;
}
