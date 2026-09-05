import { readValue, type ValueFormat } from '@binanalyzer/core';
import type { ScanConfig } from './config.js';
import type { AxisCandidate } from './axes.js';
import type { TableCandidate } from './tables.js';

/**
 * Stage 4 — Axis↔table association (spec §4.4).
 * Match axis candidates to tables by count (== cols → x, == rows → y),
 * preferring immediately-preceding layout [x][y][data], then nearby runs
 * within config.associate.maxAxisDistance. Count-prefixed pool layouts are
 * handled by pool.ts (spec §4.4 addendum 2). All lookups go through
 * AxisIndex — the semantics are identical to the original linear scans
 * (pinned by test/parity.test.ts); only the complexity changed.
 */
export interface AssociatedTable {
  table: TableCandidate;
  xAxis?: AxisCandidate;
  yAxis?: AxisCandidate;
  /** 0..1 quality of the axis fit (0 when no axes found). */
  axisFit: number;
}

const axisEnd = (a: AxisCandidate): number => a.address + a.count * a.format.width;
const fmtKey = (f: ValueFormat): string => `${f.width}:${f.signed}:${f.endianness}`;

/**
 * Lookup structures over one scanAxes() result. Built once per associate()/
 * rankAndEmit() call; all arrays preserve deterministic order (stable sorts,
 * input order among ties) so results are bit-identical to linear scanning.
 */
export interface AxisIndex {
  /** count -> axes sorted by end asc (input order among equal ends). */
  byCount: Map<number, AxisCandidate[]>;
  /** count -> the same axes' end addresses (parallel array, for binary search). */
  byCountEnds: Map<number, number[]>;
  /** `${count}:${end}` -> axes in input order (exact anchor lookups). */
  byCountEnd: Map<string, AxisCandidate[]>;
  /** format key -> runs sorted by address asc (covering-run lookups). */
  byFormat: Map<string, AxisCandidate[]>;
  /** format key -> max run span in bytes (count·width) — covering-scan bound. */
  byFormatMaxSpan: Map<string, number>;
  input: AxisCandidate[];
  inputPos: Map<AxisCandidate, number>;
}

export function buildAxisIndex(axes: AxisCandidate[]): AxisIndex {
  const byCount = new Map<number, AxisCandidate[]>();
  const byCountEnd = new Map<string, AxisCandidate[]>();
  const byFormat = new Map<string, AxisCandidate[]>();
  const byFormatMaxSpan = new Map<string, number>();
  for (const a of axes) {
    const c = byCount.get(a.count) ?? [];
    c.push(a);
    byCount.set(a.count, c);
    const k = `${a.count}:${axisEnd(a)}`;
    const e = byCountEnd.get(k) ?? [];
    e.push(a);
    byCountEnd.set(k, e);
    const fk = fmtKey(a.format);
    const f = byFormat.get(fk) ?? [];
    f.push(a);
    byFormat.set(fk, f);
    const span = a.count * a.format.width;
    if (span > (byFormatMaxSpan.get(fk) ?? 0)) byFormatMaxSpan.set(fk, span);
  }
  const byCountEnds = new Map<number, number[]>();
  for (const [count, arr] of byCount) {
    const decorated = arr.map((a, i) => ({ a, i, end: axisEnd(a) }));
    decorated.sort((p, q) => p.end - q.end || p.i - q.i);
    byCount.set(count, decorated.map((d) => d.a));
    byCountEnds.set(count, decorated.map((d) => d.end));
  }
  for (const [k, arr] of byFormat) {
    const decorated = arr.map((a, i) => ({ a, i }));
    decorated.sort((p, q) => p.a.address - q.a.address || p.i - q.i);
    byFormat.set(k, decorated.map((d) => d.a));
  }
  const inputPos = new Map<AxisCandidate, number>();
  axes.forEach((a, i) => inputPos.set(a, i));
  return { byCount, byCountEnds, byCountEnd, byFormat, byFormatMaxSpan, input: axes, inputPos };
}

/** First index with ends[i] > v (upper bound over a sorted array). */
function upperBound(ends: number[], v: number): number {
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
 * Identical semantics to the original linear bestPreceding: minimal gap wins;
 * among equal gaps the max score wins, ties broken by first input order. Since
 * the gap only grows walking toward smaller ends, the winner lives in the
 * NEAREST end-group containing a non-excluded axis.
 */
function bestPreceding(
  idx: AxisIndex,
  count: number,
  tableStart: number,
  maxDistance: number,
  exclude?: AxisCandidate
): AxisCandidate | undefined {
  const arr = idx.byCount.get(count);
  if (!arr) return undefined;
  const ends = idx.byCountEnds.get(count)!;
  let i = upperBound(ends, tableStart) - 1;
  while (i >= 0) {
    const end = ends[i]!;
    if (tableStart - end > maxDistance) return undefined;
    let j = i;
    while (j > 0 && ends[j - 1]! === end) j--;
    let best: AxisCandidate | undefined;
    for (let k = j; k <= i; k++) {
      const a = arr[k]!;
      if (a === exclude) continue;
      // strict > keeps the first-input-order axis among equal scores
      if (!best || a.score > best.score) best = a;
    }
    if (best) return best;
    i = j - 1;
  }
  return undefined;
}

export function associate(
  tables: TableCandidate[],
  axes: AxisCandidate[],
  config: ScanConfig
): AssociatedTable[] {
  const idx = buildAxisIndex(axes);
  const maxD = config.associate.maxAxisDistance;
  const adjacencyBonus = config.associate.adjacencyBonus;
  return tables.map((table) => {
    // y (rows) sits nearest to the data in the common [x][y][data] layout
    const yAxis = bestPreceding(idx, table.rows, table.address, maxD);
    const xLimit = yAxis ? yAxis.address : table.address;
    const xAxis = bestPreceding(idx, table.cols, xLimit, maxD, yAxis);
    const contribution = (a: AxisCandidate | undefined, anchor: number): number => {
      if (!a) return 0;
      const bonus = anchor - axisEnd(a) === 0 ? adjacencyBonus : 1;
      return Math.min(1, a.score * bonus);
    };
    const parts = [contribution(xAxis, xLimit), contribution(yAxis, table.address)];
    const axisFit = (parts[0]! + parts[1]!) / 2;
    const result: AssociatedTable = { table, axisFit };
    if (xAxis) result.xAxis = xAxis;
    if (yAxis) result.yAxis = yAxis;
    return result;
  });
}

export interface Anchor {
  xAddress: number;
  xCount: number;
  xFormat: ValueFormat;
  yAddress: number;
  yCount: number;
  yFormat: ValueFormat;
  /** true when both sides matched detected candidates exactly (no derived windows). */
  exact: boolean;
}

const runKey = (a: AxisCandidate): string => `${a.address}:${axisEnd(a)}`;

/**
 * First run (in INPUT order) with count >= `count` covering the `count`-cell
 * window that ends exactly at `end`, aligned to the run's own grid — identical
 * to the original linear scan. Per format bucket, runs sorted by address are
 * scanned backward from the last address <= window start; a covering run's
 * address is >= end − (bucket max span), which bounds the backscan provably.
 */
function coveringRun(
  idx: AxisIndex,
  count: number,
  end: number,
  not?: AxisCandidate
): { run: AxisCandidate; start: number } | undefined {
  let best: { run: AxisCandidate; start: number; inputPos: number } | undefined;
  for (const [fk, arr] of idx.byFormat) {
    if (arr.length === 0) continue;
    const w = arr[0]!.format.width;
    const start = end - count * w;
    if (start < 0) continue;
    const minAddr = end - idx.byFormatMaxSpan.get(fk)!;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]!.address <= start) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo - 1; j >= 0 && arr[j]!.address >= minAddr; j--) {
      const a = arr[j]!;
      if (
        a.count >= count &&
        axisEnd(a) >= end &&
        (start - a.address) % a.format.width === 0 &&
        (!not || runKey(a) !== runKey(not))
      ) {
        const pos = idx.inputPos.get(a)!;
        if (!best || pos < best.inputPos) best = { run: a, start, inputPos: pos };
      }
    }
  }
  return best ? { run: best.run, start: best.start } : undefined;
}

/**
 * Detect the zero-gap [x-axis][y-axis][data] chain for a table candidate
 * (spec §4.4 "immediately preceding in memory"; §4.4 axis match raises
 * confidence "substantially" — stage 5 uses this as a top ranking tier).
 * Exact side: a detected candidate with count === rows ending at the table
 * start (y), or count === cols ending at the y start (x), within
 * config.associate.anchorMaxGap. Derived side: the same-size window carved
 * from a detected monotone run that fully covers it — monotone runs are
 * monotone in every contiguous sub-window, so the carved window is a valid
 * axis even when scanAxes fused it into a longer run (dominant real case:
 * the y-axis fusing into the map's ascending first row). The two derived
 * windows normally come from DISTINCT runs: unconstrained single-run carving
 * manufactures anchors inside smooth map interiors. With bytes available,
 * two distinct constant steps and a separate join can establish a split.
 *
 * Accepts either the raw candidate array (builds an index — test/one-shot
 * convenience) or a prebuilt AxisIndex (hot path: rankAndEmit builds it once).
 * Semantics are identical to the pre-index linear version (parity-pinned).
 */
export function findAnchor(
  table: TableCandidate,
  axesOrIndex: AxisCandidate[] | AxisIndex,
  config: ScanConfig,
  bytes?: Uint8Array
): Anchor | undefined {
  const idx = Array.isArray(axesOrIndex) ? buildAxisIndex(axesOrIndex) : axesOrIndex;
  const maxGap = config.associate.anchorMaxGap;
  const { rows, cols, address: tableStart } = table;

  const exactEndingAt = (count: number, end: number, not?: AxisCandidate): AxisCandidate | undefined => {
    for (let g = 0; g <= maxGap; g++) {
      const arr = idx.byCountEnd.get(`${count}:${end - g}`);
      if (arr) {
        for (const a of arr) if (!not || runKey(a) !== runKey(not)) return a;
      }
    }
    return undefined;
  };

  // Exact y first (candidate runs of exactly `rows` cells ending at the table).
  const yExacts: AxisCandidate[] = [];
  for (let g = 0; g <= maxGap; g++) {
    const arr = idx.byCountEnd.get(`${rows}:${tableStart - g}`);
    if (arr) yExacts.push(...arr);
  }
  for (const y of yExacts) {
    const x = exactEndingAt(cols, y.address, y);
    if (x) {
      return {
        exact: true,
        xAddress: x.address, xCount: cols, xFormat: x.format,
        yAddress: y.address, yCount: rows, yFormat: y.format,
      };
    }
  }
  for (const y of yExacts) {
    const xD = coveringRun(idx, cols, y.address, y);
    if (xD) {
      return {
        exact: false,
        xAddress: xD.start, xCount: cols, xFormat: xD.run.format,
        yAddress: y.address, yCount: rows, yFormat: y.format,
      };
    }
  }
  // Derived y: carve the window immediately preceding the table out of a
  // covering run — original iterates axes in INPUT order; gather the (few)
  // covering runs per bucket and replay them in input order.
  const covering: AxisCandidate[] = [];
  for (const [fk, arr] of idx.byFormat) {
    if (arr.length === 0) continue;
    const w2 = arr[0]!.format.width;
    const yStart = tableStart - rows * w2;
    if (yStart < 0) continue;
    const minAddr = tableStart - idx.byFormatMaxSpan.get(fk)!;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]!.address <= yStart) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo - 1; j >= 0 && arr[j]!.address >= minAddr; j--) {
      const b = arr[j]!;
      if (
        b.count >= rows &&
        b.address <= yStart &&
        axisEnd(b) >= tableStart &&
        (yStart - b.address) % b.format.width === 0
      ) {
        covering.push(b);
      }
    }
  }
  covering.sort((a, b) => idx.inputPos.get(a)! - idx.inputPos.get(b)!);
  for (const R2 of covering) {
    const w2 = R2.format.width;
    const yStart = tableStart - rows * w2;
    const xE = exactEndingAt(cols, yStart, R2);
    if (xE) {
      return {
        exact: false,
        xAddress: xE.address, xCount: cols, xFormat: xE.format,
        yAddress: yStart, yCount: rows, yFormat: R2.format,
      };
    }
    const xD = coveringRun(idx, cols, yStart, R2);
    if (xD) {
      return {
        exact: false,
        xAddress: xD.start, xCount: cols, xFormat: xD.run.format,
        yAddress: yStart, yCount: rows, yFormat: R2.format,
      };
    }
  }
  // A fused run is insufficient by itself. Two constant, unequal steps with
  // a join matching neither step provide an independent axis boundary.
  if (bytes && rows >= config.axis.minCount && cols >= config.axis.minCount && tableStart <= bytes.length) {
    for (const run of covering) {
      const w = run.format.width;
      const xStart = tableStart - (rows + cols) * w;
      if (xStart < run.address || (xStart - run.address) % w !== 0) continue;
      const yStart = tableStart - rows * w;
      const step = (start: number, count: number): number | undefined => {
        const delta = readValue(bytes, start + w, run.format) - readValue(bytes, start, run.format);
        if (delta === 0) return undefined;
        for (let i = 2; i < count; i++) {
          if (readValue(bytes, start + i * w, run.format) - readValue(bytes, start + (i - 1) * w, run.format) !== delta) return undefined;
        }
        return delta;
      };
      const xStep = step(xStart, cols);
      const yStep = step(yStart, rows);
      const join = readValue(bytes, yStart, run.format) - readValue(bytes, yStart - w, run.format);
      if (xStep !== undefined && yStep !== undefined && xStep !== yStep && join !== xStep && join !== yStep) {
        return { exact: false, xAddress: xStart, xCount: cols, xFormat: run.format,
          yAddress: yStart, yCount: rows, yFormat: run.format };
      }
    }
  }
  return undefined;
}
