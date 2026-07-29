import type { ScanConfig } from '../../config.js';
import type { FamilyDetection } from '../types.js';
import type { ReaderCall } from './c166.js';
import type { ValueFormat } from '@binanalyzer/core';
import { MS41_CAL_SA_MAX, MS41_CAL_SA_MIN, saSpanContiguous, saToFo } from './frame.js';
import { readU16SA, validateAxisPtr } from './header.js';

/** Curves rank below every grid tier (0–3) — a curve must never displace a grid. */
export const CURVE_TIER = 4;
const u8: ValueFormat = { width: 1, signed: false, endianness: 'big' };
const u16le: ValueFormat = { width: 2, signed: false, endianness: 'little' };
const fmtFor = (w: 1 | 2): ValueFormat => (w === 1 ? u8 : u16le);

/**
 * MS41 1D-curve detection (spec 2026-07-15). Per distinct cal-SA arg to a
 * self-located curve reader, decode the 2-byte backward [axisPtr] header → the
 * axis count IS the curve length; emit an N×1 (rows=count, cols=1) tier-CURVE_TIER
 * detection with a single yAxis. Guards identical to the grid path: contiguous
 * in-cal span, no 0x4000 seam. Smoothness NOT gated (code-referenced = real).
 */
export function detectMs41Curves(
  bytes: Uint8Array,
  calls: ReaderCall[],
  readers: Map<number, 1 | 2>,
  config: ScanConfig
): FamilyDetection[] {
  const { curveAxisMinCount } = config.family.ms41;
  const seen = new Map<number, 1 | 2>();
  for (const c of calls) {
    if (c.sa < MS41_CAL_SA_MIN || c.sa > MS41_CAL_SA_MAX) continue;
    const w = readers.get(c.targetCpu);
    if (w) seen.set(c.sa, w);
  }
  const out: FamilyDetection[] = [];
  for (const [sa, w] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
    const ptr = readU16SA(bytes, sa - 2);
    if (ptr >= sa) continue;
    const ax = validateAxisPtr(bytes, ptr, config, { minCount: curveAxisMinCount });
    if (!ax) continue;
    const byteLen = ax.count * w;
    if (!saSpanContiguous(sa, byteLen)) continue;
    const fo = saToFo(sa);
    if (fo + byteLen > bytes.length) continue;
    out.push({
      address: fo, rows: ax.count, cols: 1, format: fmtFor(w),
      score: 0.9, tier: CURVE_TIER, kind: '1d',
      yAxis: { address: saToFo(ax.dataSA), count: ax.count, format: fmtFor(ax.width) },
    });
  }
  return out;
}

/** Fallback curve tiers: weaker evidence than the 2-byte-header tier-4 path,
 *  so they rank strictly after it (and after every grid tier 0–3). The
 *  spike's skeptic review REFUTED elevating these above loose grids as
 *  structurally safe — do not renumber below 4. */
export const CURVE_FALLBACK_TIER = 5;
export const CURVE_ADJ_TIER = 6;

/**
 * MS41 fallback 1D-curve detection (Phase 1.1, spike 2026-07-15). Two passes
 * over the distinct cal-SA args of self-located curve readers that the
 * tier-4 header path does NOT own:
 *  - TIER 5: the same 2-byte backward [axisPtr] header, validated at the
 *    EMISSION floor curveEmitMinCount (recovers count-2/3 curves — the 3
 *    former "stock misses" 0x1bc8/0x28f6/0x28fc + s52 0x33d2/0x33f8).
 *  - TIER 6 (Task 2): axis-adjacency for headerless SS1v2 customs.
 * Measured: e36m3 +15 emissions (curve rows 0.953→1.000/1.000), s52 +17
 * at tier 5 alone (0.831→0.901, axis RISES to 0.984); grid recall unchanged.
 */
export function detectMs41CurveFallbacks(
  bytes: Uint8Array,
  calls: ReaderCall[],
  readers: Map<number, 1 | 2>,
  config: ScanConfig
): FamilyDetection[] {
  const { curveAxisMinCount, curveEmitMinCount } = config.family.ms41;
  const seen = new Map<number, 1 | 2>();
  for (const c of calls) {
    if (c.sa < MS41_CAL_SA_MIN || c.sa > MS41_CAL_SA_MAX) continue;
    const w = readers.get(c.targetCpu);
    if (w) seen.set(c.sa, w);
  }
  const out: FamilyDetection[] = [];
  const claimed = new Set<number>();
  // The tier-4 path owns every SA whose backward header validates at the
  // self-location floor — a fallback must never shadow or duplicate it.
  // (Deliberately omits span/bounds guards: over-claiming only SUPPRESSES
  // fallback emission — emit() independently re-checks span+bounds.)
  for (const [sa] of seen) {
    const ptr = readU16SA(bytes, sa - 2);
    if (ptr < sa && validateAxisPtr(bytes, ptr, config, { minCount: curveAxisMinCount })) claimed.add(sa);
  }
  const emit = (
    sa: number, w: 1 | 2, rows: number, tier: number,
    axDataSA: number, axWidth: 1 | 2, score: number
  ): void => {
    const len = rows * w;
    if (!saSpanContiguous(sa, len)) return;
    const fo = saToFo(sa);
    if (fo + len > bytes.length) return;
    out.push({
      address: fo, rows, cols: 1, format: fmtFor(w), score, tier, kind: '1d',
      yAxis: { address: saToFo(axDataSA), count: rows, format: fmtFor(axWidth) },
    });
    claimed.add(sa);
  };
  const sas = [...seen.entries()].sort((a, b) => a[0] - b[0]);
  // TIER 5 — header at the emission floor.
  for (const [sa, w] of sas) {
    if (claimed.has(sa)) continue;
    const ptr = readU16SA(bytes, sa - 2);
    if (ptr >= sa) continue;
    const ax = validateAxisPtr(bytes, ptr, config, { minCount: curveEmitMinCount });
    if (!ax) continue;
    emit(sa, w, ax.count, CURVE_FALLBACK_TIER, ax.dataSA, ax.width, 0.7);
  }
  // TIER 6 — axis adjacency for headerless customs. A count-prefixed axis
  // run TOUCHES the data: forward [prefix][axis][data] with the prefix at
  // sa - aw*(c+1) (validateAxisPtr's count-prefix width equals the axis cell
  // width: u8 for w1, u16 for w2 — the u16 form is what recovers 0x368a);
  // reversed [data][prefix][axis] with the prefix at sa + c*w. Ambiguity →
  // smallest c (nearest structure; measured to dominate uniqueness-refusal —
  // the one real ambiguous case, 0x3622, picks the def-true c=2 over a c=20
  // grab of the neighboring open-loop axis). Same-c fwd ties (aw=1 vs aw=2)
  // break aw-ascending, matching the validated spike ladder exactly.
  const { maxCount } = config.axis;
  for (const reversed of [false, true] as const) {
    for (const [sa, w] of sas) {
      if (claimed.has(sa)) continue;
      const hits: Array<{ c: number; aw: 1 | 2; dataSA: number; width: 1 | 2 }> = [];
      for (let c = curveEmitMinCount; c <= maxCount; c++) {
        for (const aw of [1, 2] as const) {
          const p = reversed ? sa + c * w : sa - aw * (c + 1);
          if (p < MS41_CAL_SA_MIN || p > MS41_CAL_SA_MAX) continue;
          const ax = validateAxisPtr(bytes, p, config, { minCount: curveEmitMinCount, relaxed: true });
          if (!ax || ax.count !== c || ax.width !== aw) continue;
          // (tautological given ax.width===aw and p = sa - aw*(c+1) above —
          // kept as an explicit invariant of the forward layout)
          if (!reversed && ax.dataSA + c * aw !== sa) continue;
          hits.push({ c, aw, dataSA: ax.dataSA, width: ax.width });
        }
      }
      hits.sort((a, b) => a.c - b.c || a.aw - b.aw);
      const h = hits[0];
      if (h === undefined) continue;
      emit(sa, w, h.c, CURVE_ADJ_TIER, h.dataSA, h.width, 0.6);
    }
  }
  return out;
}
