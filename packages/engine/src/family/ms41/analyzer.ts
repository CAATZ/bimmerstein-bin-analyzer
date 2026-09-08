import { readValue } from '@binanalyzer/core';
import type { ValueFormat } from '@binanalyzer/core';
import type { ScanConfig } from '../../config.js';
import type { FamilyDetection, FamilyAnalyzer } from '../types.js';
import { scanReaderCalls, type ReaderCall } from './c166.js';
import { MS41_CAL_SA_MAX, MS41_CAL_SA_MIN, MS41_MIN_BIN_LEN, foToSA, inCalWindow, saSpanContiguous, saToFo } from './frame.js';
import { readU16SA, validateAxisPtr } from './header.js';
import { scanPlateauCalAxes, type FamilyPoolAxis } from './plateau.js';
import { selfLocateCurveReaders, selfLocateReaders, type ReaderEntry } from './readers.js';
import { CURVE_FALLBACK_TIER, detectMs41Curves, detectMs41CurveFallbacks } from './curves.js';
import { detectMs41Params } from './params.js';
import { analyzeMs41Consumers, supportsSignedStorage } from './consumers.js';
import { resolveMs41CurveAxes } from './runtime-axes.js';
import { detectMs41RuntimeGrids } from './runtime-grids.js';

/**
 * MS41 code-xref detection core (spec §4.6). Given the filtered start set
 * (cal SAs passed to self-located readers, with the reader's cell width),
 * emit per start:
 *  - HEADER path: the 4 bytes before the start decode as two u16 LE pointers
 *    that both validate as axis count prefixes → exact dims (cols = xCount,
 *    rows = yCount) and exact axis addresses. Smoothness is NOT gated — a
 *    code-referenced dead table is still a real table (measured: 0x35B8).
 *  - FALLBACK path (headerless starts): nearest preceding pool PAIR dims
 *    under a HARD extent cap (byteLen <= gap to the next start; 0 truth
 *    violations measured). Smoothness gated at table.minTableScore.
 * Both paths additionally require saSpanContiguous: no crossing the SA 0x4000
 * frame seam, and a hard cal-bound cap that also bounds the LAST start (whose
 * gap is undefined). Measured identical results with these guards (2026-07-09
 * integrated harness rerun: 113/115 emissions, same scores).
 * A global gap bonus was measured HARMFUL (spike) — none exists here.
 */

export interface FamilyStart {
  sa: number;
  /** saToFo(sa), precomputed. */
  fo: number;
  w: 1 | 2;
}

const u8Fmt: ValueFormat = { width: 1, signed: false, endianness: 'big' };
const u16Fmt: ValueFormat = { width: 2, signed: false, endianness: 'little' };
const axisFmt = (w: 1 | 2): ValueFormat => (w === 1 ? u8Fmt : u16Fmt);

/**
 * Frame smoothness in 0..1: 1 − (mean row |Δ| + mean col |Δ|)/(range + 1),
 * 0.1 for flat blocks (same composite the spike scored with; local to the
 * family pass — the byte pipeline's scoring lives in tables.ts).
 */
function frameScore(bytes: Uint8Array, addr: number, rows: number, cols: number, fmt: ValueFormat): number {
  const w = fmt.width;
  if (addr + rows * cols * w > bytes.length) return -1;
  let min = Infinity;
  let max = -Infinity;
  let rowTv = 0;
  let colTv = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = readValue(bytes, addr + (r * cols + c) * w, fmt);
      if (v < min) min = v;
      if (v > max) max = v;
      if (c > 0) rowTv += Math.abs(v - readValue(bytes, addr + (r * cols + c - 1) * w, fmt));
      if (r > 0) colTv += Math.abs(v - readValue(bytes, addr + ((r - 1) * cols + c) * w, fmt));
    }
  }
  const range = max - min;
  const rt = rowTv / Math.max(1, rows * (cols - 1));
  const ct = colTv / Math.max(1, (rows - 1) * cols);
  return range <= 0 ? 0.1 : Math.max(0, 1 - (rt + ct) / (range + 1));
}

export function detectMs41Tables(
  bytes: Uint8Array,
  starts: FamilyStart[],
  pool: FamilyPoolAxis[],
  config: ScanConfig,
  knownObjects: FamilyDetection[] = []
): FamilyDetection[] {
  const { minCols, maxCols, minRows, maxRows, minTableScore } = config.table;
  const { window, pairSpan } = config.pool;
  const sorted = [...starts].sort((a, b) => a.sa - b.sa);
  const poolSorted = [...pool].sort((a, b) => a.end - b.end || a.address - b.address);
  const out: FamilyDetection[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    // Defensive: buildMs41Starts guarantees this in the wired path, but this
    // function is exported — an out-of-range SA would read masked garbage.
    if (s.sa < MS41_CAL_SA_MIN || s.sa > MS41_CAL_SA_MAX) continue;
    const gap = i + 1 < sorted.length ? sorted[i + 1]!.sa - s.sa : undefined;
    const fmt = s.w === 1 ? u8Fmt : u16Fmt;
    // HEADER path (v2.1): axis floor family.ms41.headerAxisMinCount — real
    // headers reference 3-count axes (Class A). xPtr≠yPtr guard: real headers
    // never share pointers (the one observed same-pointer phantom, s52
    // 0x39BE's data bytes, appears exactly at minCount 2 and would claim the
    // span its true 20×20 fallback framing needs). Backward guard: every real
    // header points backward — measured s52 59/59, e36m3 61/61, forward 0/0;
    // forward "headers" are data bytes, e.g. 0x35B8's pre-bytes →
    // 0x3732/0x3F3B.
    const xp = readU16SA(bytes, s.sa - 4);
    const yp = readU16SA(bytes, s.sa - 2);
    const hdrBlocked = xp === yp || !(xp < s.sa && yp < s.sa);
    const hdrOpts = { minCount: config.family.ms41.headerAxisMinCount };
    const xAx = hdrBlocked ? undefined : validateAxisPtr(bytes, xp, config, { ...hdrOpts, nextPtr: yp });
    const yAx = hdrBlocked ? undefined : validateAxisPtr(bytes, yp, config, { ...hdrOpts, nextPtr: xp });
    if (xAx && yAx) {
      const cols = xAx.count;
      const rows = yAx.count;
      const byteLen = rows * cols * s.w;
      const okDims = cols >= minCols && cols <= maxCols && rows >= minRows && rows <= maxRows;
      const okLen = gap === undefined || byteLen <= gap;
      if (okDims && okLen && saSpanContiguous(s.sa, byteLen) && s.fo + byteLen <= bytes.length) {
        out.push({
          address: s.fo,
          rows,
          cols,
          format: fmt,
          score: Math.max(0.01, frameScore(bytes, s.fo, rows, cols, fmt)),
          tier: 0,
          xAxis: { address: saToFo(xAx.dataSA), count: xAx.count, format: axisFmt(xAx.width) },
          yAxis: { address: saToFo(yAx.dataSA), count: yAx.count, format: axisFmt(yAx.width) },
        });
        continue; // header wins for this start
      }
    }
    // FALLBACK path: nearest preceding pool pairs, extent-hard
    const near: FamilyPoolAxis[] = [];
    for (let k = poolSorted.length - 1; k >= 0; k--) {
      const p = poolSorted[k]!;
      if (p.end > s.fo) continue;
      if (s.fo - p.end > window) break;
      near.push(p);
    }
    for (let a = 0; a < near.length; a++) {
      for (let b = 0; b < near.length; b++) {
        if (a === b) continue;
        const x = near[a]!;
        const y = near[b]!;
        if (x.address === y.address) continue;
        if (Math.max(x.address, y.address) - Math.min(x.end, y.end) > pairSpan) continue;
        const cols = x.count;
        const rows = y.count;
        if (cols < minCols || cols > maxCols || rows < minRows || rows > maxRows) continue;
        const byteLen = rows * cols * fmt.width;
        if (!saSpanContiguous(s.sa, byteLen)) continue;
        if (s.fo + byteLen > bytes.length) continue;
        if (gap !== undefined && byteLen > gap) continue;
        if (knownObjects.some(c => (c.kind === 'param' || (c.kind === '1d' && c.tier <= CURVE_FALLBACK_TIER))
          && s.fo < c.address + c.rows * c.format.width && s.fo + byteLen > c.address)) continue;
        const score = frameScore(bytes, s.fo, rows, cols, fmt);
        // v2.1: waive the smoothness floor for adjacency-TIGHT pairs — an
        // axis run ending exactly at the table start is the stock
        // [axes][table] law and stronger evidence than frame smoothness
        // (measured: 0x35B8, a dead 10×10 with its x run ending at its first
        // byte, frameScore 0.10). Emission priority (Task 8) keeps waived
        // candidates below header-backed ones and above nothing they don't earn.
        const tight = Math.max(x.end, y.end) === s.fo;
        if (score < minTableScore && !tight) continue;
        out.push({
          address: s.fo,
          rows,
          cols,
          format: fmt,
          score: Math.max(0.01, score),
          tier: tight ? 1 : 2,
          xAxis: { address: x.address, count: x.count, format: x.format },
          yAxis: { address: y.address, count: y.count, format: y.format },
        });
      }
    }
  }
  return out;
}

/**
 * Scan-tier sweep floor: the lowest SA with a 4-byte header above it whose
 * pointers can still satisfy MS41_CAL_SA_MIN. MEASURED-BEHAVIOR constant
 * (part of the V4–V6 ladder rungs), not a tuning knob.
 */
const SCAN_SA_MIN = 12;

/**
 * Relaxed-header SCAN tier (v2.1, spec §4.6 — family tier 3, the lowest):
 * sweep every cal SA for a 4-byte header whose BOTH pointers validate under
 * plateau/dead-tolerant rules (family.ms41.scanAxisMinCount; dead axes are
 * real — measured: MAF 0x2AD6's stored axis cells are zero on both bins, and
 * its SA is never an r12 immediate, so no dataflow window reaches it). Width:
 * an established reader width wins; otherwise an exact gap==byteLen match
 * against the next r12 start wins, else higher
 * frameScore, w2 tried first. Extent: capped by the gap to the next r12
 * start, saSpanContiguous, and the buffer. Emissions land BELOW every other
 * family tier and RECLAIM junk byte-tier spans (measured: total detections
 * DROP, s52 fpD falls).
 */
export function scanRelaxedHeaderTables(
  bytes: Uint8Array,
  starts: FamilyStart[],
  config: ScanConfig,
  curves: FamilyDetection[] = []
): FamilyDetection[] {
  const { minCols, maxCols, minRows, maxRows } = config.table;
  const relaxedOpts = { minCount: config.family.ms41.scanAxisMinCount, relaxed: true };
  const widths = new Map(starts.map(s => [s.sa, s.w]));
  const startSAs = starts.map((s) => s.sa).sort((a, b) => a - b);
  const nextStart = (sa: number): number | undefined => {
    let lo = 0;
    let hi = startSAs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (startSAs[mid]! <= sa) lo = mid + 1;
      else hi = mid;
    }
    return lo < startSAs.length ? startSAs[lo] : undefined;
  };
  const out: FamilyDetection[] = [];
  const curveSpans = curves.filter(c => c.kind === '1d' && c.tier <= CURVE_FALLBACK_TIER)
    .map(c => [c.address, c.address + c.rows * c.cols * c.format.width] as const);
  for (let sa = SCAN_SA_MIN; sa <= MS41_CAL_SA_MAX - 4; sa++) {
    const xp = readU16SA(bytes, sa - 4);
    const yp = readU16SA(bytes, sa - 2);
    if (xp === yp || xp === 0 || yp === 0 || xp === 0xffff || yp === 0xffff) continue;
    if (!(xp < sa && yp < sa)) continue; // v2.1: backward-pointer guard (see detectMs41Tables)
    const x = validateAxisPtr(bytes, xp, config, { ...relaxedOpts, nextPtr: yp });
    const y = validateAxisPtr(bytes, yp, config, { ...relaxedOpts, nextPtr: xp });
    if (!x || !y) continue;
    const cols = x.count;
    const rows = y.count;
    if (cols < minCols || cols > maxCols || rows < minRows || rows > maxRows) continue;
    const ns = nextStart(sa);
    const gap = ns !== undefined ? ns - sa : undefined;
    const fo = saToFo(sa);
    let best: { w: 1 | 2; score: number; exact: boolean } | undefined;
    for (const w of [2, 1] as const) {
      if (widths.has(sa) && widths.get(sa) !== w) continue;
      const byteLen = rows * cols * w;
      if (!saSpanContiguous(sa, byteLen)) continue;
      if (fo + byteLen > bytes.length) continue;
      if (gap !== undefined && byteLen > gap) continue;
      // A validated curve-reader call rules out an inferred grid across its data.
      if (curveSpans.some(([start, end]) => fo < end && fo + byteLen > start)) continue;
      const sc = frameScore(bytes, fo, rows, cols, axisFmt(w));
      const exact = gap !== undefined && byteLen === gap;
      if (!best || (exact && !best.exact) || (exact === best.exact && sc > best.score)) {
        best = { w, score: sc, exact };
      }
    }
    if (!best) continue;
    out.push({
      address: fo,
      rows,
      cols,
      format: axisFmt(best.w),
      score: Math.max(0.01, best.score),
      tier: 3,
      xAxis: { address: saToFo(x.dataSA), count: x.count, format: axisFmt(x.width) },
      yAxis: { address: saToFo(y.dataSA), count: y.count, format: axisFmt(y.width) },
    });
  }
  return out;
}

/**
 * Assemble the filtered start set: every distinct cal-SA passed to a selected
 * reader, carrying that reader's cell width (later call sites win ties in
 * calls order — deterministic). Sorted by SA so gap-to-next-start is defined.
 */
export function buildMs41Starts(calls: ReaderCall[], readers: ReaderEntry[]): FamilyStart[] {
  const width = new Map(readers.map((r) => [r.target, r.width]));
  const saw = new Map<number, 1 | 2>();
  for (const c of calls) {
    if (c.sa < MS41_CAL_SA_MIN || c.sa > MS41_CAL_SA_MAX) continue;
    const w = width.get(c.targetCpu);
    if (w) saw.set(c.sa, w);
  }
  return [...saw.entries()]
    .map(([sa, w]) => ({ sa, fo: saToFo(sa), w }))
    .filter((s) => inCalWindow(s.fo))
    .sort((a, b) => a.sa - b.sa);
}

/**
 * MS41/C166 family analyzer (spec §4.6). Compound activation gate — ALL of:
 *  1. bytes.length >= MS41_MIN_BIN_LEN (frame law must address the cal window);
 *  2. >= family.ms41.movImmCalMin MOV r12,#cal-SA fresh call sites (measured:
 *     real MS41 721/769, every synthetic fixture 0);
 *  3. >= family.ms41.minReaders self-located readers (header-validation rate
 *     over distinct args; both real bins select the same trio — requiring 2
 *     hardens against sibling-C166 false activation at zero measured cost).
 * Off-family bins return [] and the byte pipeline is byte-identical.
 */
export const ms41Analyzer: FamilyAnalyzer = {
  id: 'ms41',
  analyze(bytes, prefixedAxes, config) {
    const { maxR12Dist, movImmCalMin, readerMinArgs, readerHeaderRateMin, widthScanMaxInstr, minReaders } =
      config.family.ms41;
    if (bytes.length < MS41_MIN_BIN_LEN) return [];
    const calls = scanReaderCalls(bytes, maxR12Dist);
    let movImmCal = 0;
    for (const c of calls) if (c.sa >= MS41_CAL_SA_MIN && c.sa <= MS41_CAL_SA_MAX) movImmCal++;
    if (movImmCal < movImmCalMin) return [];
    const readers = selfLocateReaders(bytes, calls, config, readerMinArgs, readerHeaderRateMin, widthScanMaxInstr);
    if (readers.length < minReaders) return [];
    const starts = buildMs41Starts(calls, readers);
    const runtimeGrids = detectMs41RuntimeGrids(bytes, calls, readers, config);
    const runtimeAddresses = new Set(runtimeGrids.map(g => g.address));
    for (const grid of runtimeGrids) {
      if (!starts.some(s => s.fo === grid.address)) starts.push({ sa: foToSA(grid.address), fo: grid.address, w: grid.format.width as 1 | 2 });
    }
    // v2.1: the family fallback pool = maximal generic pool axes ∪ plateau
    // axes (dedup by address/count/width). Plateau axes exist ONLY inside the
    // family pass — the generic pool tier never sees them.
    const pool: FamilyPoolAxis[] = [...prefixedAxes.filter((p) => p.maximal)];
    const seen = new Set(pool.map((p) => `${p.address}/${p.count}/${p.format.width}`));
    for (const p of scanPlateauCalAxes(bytes, config)) {
      const k = `${p.address}/${p.count}/${p.format.width}`;
      if (!seen.has(k)) {
        seen.add(k);
        pool.push(p);
      }
    }
    // 1D-curve tier (spec 2026-07-15): self-locate curve readers, emit N×1
    // header-backed curves BELOW every grid tier. Gated so it is inert off the
    // real MS41 family (synthetics: 0 curve-reader args).
    const curveReaders = selfLocateCurveReaders(bytes, calls, config);
    let curveArgs = 0;
    for (const c of calls) if (curveReaders.has(c.targetCpu)) curveArgs++;
    const runtimeAxes = resolveMs41CurveAxes(bytes, calls, curveReaders, config);
    const curves =
      curveArgs >= config.family.ms41.curveActivateMin
        ? [
            ...detectMs41Curves(bytes, calls, curveReaders, config, runtimeAxes),
            ...detectMs41CurveFallbacks(bytes, calls, curveReaders, config)
              .filter(curve => !runtimeAxes.has(foToSA(curve.address))),
          ]
        : [];
    // Param tier (Switch Phase B): S* census behind the defense-in-depth
    // readers-trio guard (both real bins locate 3; curve synths locate 2).
    // The pinned zero-emission fixture tests remain the authority.
    const consumerWidths = new Map([...readers.map(r => [r.target, r.width] as const), ...curveReaders]);
    const consumers = analyzeMs41Consumers(bytes, calls, consumerWidths, config);
    const params =
      readers.length >= config.family.ms41.paramMinReaders ? detectMs41Params(bytes, config, consumers.memory) : [];
    const tables = [
      ...runtimeGrids,
      ...detectMs41Tables(bytes, starts, pool, config, [...curves, ...params]).filter(t => !runtimeAddresses.has(t.address)),
      ...scanRelaxedHeaderTables(bytes, starts, config, curves).filter(t => !runtimeAddresses.has(t.address)),
      ...curves,
    ];
    for (const table of tables) {
      const sa = foToSA(table.address);
      const evidence = consumers.tables.get(sa);
      if (supportsSignedStorage(bytes, table.address, table.rows * table.cols, table.format, evidence)) table.format = { ...table.format, signed: true };
    }
    return [...tables, ...params];
  },
};
