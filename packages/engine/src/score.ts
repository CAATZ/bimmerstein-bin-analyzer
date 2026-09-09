import type { AxisDef, MapDef } from '@binanalyzer/core';
import { readAxisValues, readValue } from '@binanalyzer/core';
import type { ScanConfig } from './config.js';
import type { AssociatedTable } from './associate.js';
import { findAnchor, buildAxisIndex, type Anchor } from './associate.js';
import type { AxisCandidate } from './axes.js';
import { colTvAt, type TableCandidate } from './tables.js';
import { buildPoolIndex, findPoolAnchor, isPoolActive, type PoolAnchor, type PoolStructTable, type PrefixedAxis } from './pool.js';
import type { FamilyDetection } from './family/types.js';

/**
 * Stage 5 — Scoring, overlap resolution, ranking (spec §4.5).
 * Composite confidence from smoothness, axis fit, and dimension prior (the
 * region prior is implicit: candidates only come from 'data' regions).
 * Overlaps resolved by interval scheduling on score. Output is ranked
 * MapDef[] with provenance 'auto' and confidence set.
 */

/** All breakpoints/weights are config.score fields — never inline here. */
function dimPrior(rows: number, cols: number, config: ScanConfig): number {
  const {
    dimPriorIdealMin,
    dimPriorIdealMax,
    dimPriorIdealWeight,
    dimPriorOkMin,
    dimPriorOkMax,
    dimPriorOkWeight,
    dimPriorFallbackWeight,
  } = config.score;
  if (rows >= dimPriorIdealMin && rows <= dimPriorIdealMax && cols >= dimPriorIdealMin && cols <= dimPriorIdealMax) {
    return dimPriorIdealWeight;
  }
  if (rows >= dimPriorOkMin && rows <= dimPriorOkMax && cols >= dimPriorOkMin && cols <= dimPriorOkMax) {
    return dimPriorOkWeight;
  }
  return dimPriorFallbackWeight;
}

function toAxisDef(a: AxisCandidate | undefined): AxisDef | undefined {
  if (!a) return undefined;
  return { kind: 'referenced', address: a.address, count: a.count, format: a.format };
}

function byteSpan(t: { address: number; rows: number; cols: number; format: { width: number } }): [number, number] {
  return [t.address, t.address + t.rows * t.cols * t.format.width];
}

function overlapFrac(a: [number, number], b: [number, number]): number {
  const inter = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  return inter / Math.max(1, Math.min(a[1] - a[0], b[1] - b[0]));
}

/**
 * Spec §4.3's "correct column count minimizes vertical discontinuity" as a
 * one-sided gate: widening an anchored block by one column must sharply raise
 * its mean row-to-row variation. Measured true-block ratios: 37–225×;
 * spurious blocks ≈1×. When the widened block would run past the bin, retry
 * with fewer rows (≥2) so blocks at the end of data are still measurable.
 */
function shearOk(bytes: Uint8Array, t: TableCandidate, config: ScanConfig): boolean {
  const base = colTvAt(bytes, t.address, t.rows, t.cols, t.format);
  if (base === undefined) return false;
  let rows = t.rows;
  let wide = colTvAt(bytes, t.address, rows, t.cols + 1, t.format);
  while (wide === undefined && rows > 2) {
    rows -= 1;
    wide = colTvAt(bytes, t.address, rows, t.cols + 1, t.format);
  }
  if (wide === undefined) return false;
  // 1e-9: structural divide-by-zero guard (same role as tables.ts's `range + 1`).
  return wide / (base + 1e-9) >= config.score.shearGateMin;
}

/**
 * Start-edge contrast (pool-tier membership, spec §4.5 addendum 2): a TRUE
 * table begins at a data boundary — the mean |Δ| between its first row and
 * the pseudo-row immediately before it is large relative to the block's own
 * row-to-row variation. Sub-blocks and phase-shifted misframes begin inside
 * smooth data (ratio ≈ 1). Same one-sided ratio form as the shear gate (the
 * shear gate itself was measured to be the wrong membership test here: true
 * w1 framings measure 3–12× when their neighbors are smooth).
 * An out-of-bounds previous row counts as an edge.
 */
function startEdgeStrength(bytes: Uint8Array, t: TableCandidate): number | undefined {
  const w = t.format.width;
  const prevRowAddr = t.address - t.cols * w;
  if (prevRowAddr < 0) return Infinity;
  const boundary = colTvAt(bytes, prevRowAddr, 2, t.cols, t.format);
  if (boundary === undefined) return Infinity;
  const internal = colTvAt(bytes, t.address, t.rows, t.cols, t.format);
  if (internal === undefined) return undefined;
  // 1e-9: structural divide-by-zero guard (same role as shearOk's).
  return boundary / (internal + 1e-9);
}

export function startEdgeOk(bytes: Uint8Array, t: TableCandidate, edgeMin: number): boolean {
  const strength = startEdgeStrength(bytes, t);
  return strength !== undefined && strength >= edgeMin;
}

/**
 * Bottom end-edge contrast (pool-tier membership, spec §4.5 stage-3 addendum):
 * mirror of startEdgeOk at the block's bottom. The mean |Δ| between the block's
 * last row and the pseudo-row immediately after it must be large relative to the
 * block's own row-to-row variation. Requiring BOTH edges removes spurious pool
 * candidates that a single top edge admitted (a misframe inside smooth data has
 * no real bottom boundary). An out-of-bounds next row counts as an edge.
 */
function endEdgeStrength(bytes: Uint8Array, t: TableCandidate): number | undefined {
  const w = t.format.width;
  const lastRowAddr = t.address + (t.rows - 1) * t.cols * w;
  const boundary = colTvAt(bytes, lastRowAddr, 2, t.cols, t.format);
  if (boundary === undefined) return Infinity;
  const internal = colTvAt(bytes, t.address, t.rows, t.cols, t.format);
  if (internal === undefined) return undefined;
  // 1e-9: structural divide-by-zero guard (same role as startEdgeOk's).
  return boundary / (internal + 1e-9);
}

export function endEdgeOk(bytes: Uint8Array, t: TableCandidate, edgeMin: number): boolean {
  const strength = endEdgeStrength(bytes, t);
  return strength !== undefined && strength >= edgeMin;
}

/** Boundary prediction errors relative to variation around each column's row trend. */
function trendEdges(bytes: Uint8Array, t: TableCandidate, residualFloor: number): [number, number] {
  const { address, rows, cols, format } = t;
  const stride = cols * format.width;
  // At least two row differences are needed to measure residual variation.
  if (rows < 3 || cols < 2 || address < 0 || address + rows * stride > bytes.length) return [0, 0];
  let noise = 0, before = 0, after = 0;
  for (let c = 0; c < cols; c++) {
    const at = (r: number): number => readValue(bytes, address + r * stride + c * format.width, format);
    const mean = (at(rows - 1) - at(0)) / (rows - 1);
    for (let r = 1; r < rows; r++) noise += Math.abs(at(r) - at(r - 1) - mean);
    if (address >= stride) before += Math.abs(at(0) - at(-1) - mean);
    if (address + (rows + 1) * stride <= bytes.length) after += Math.abs(at(rows) - at(rows - 1) - mean);
  }
  // One raw integer step is the quantization floor; exact ramps must not turn
  // sub-cell residuals into arbitrarily strong boundary evidence.
  const denominator = Math.max(residualFloor, noise / ((rows - 1) * cols));
  return [
    address < stride ? Infinity : before / cols / denominator,
    address + (rows + 1) * stride > bytes.length ? Infinity : after / cols / denominator,
  ];
}

/**
 * Row resets should explain changes in the flattened cell sequence. Compare
 * variation before/after separating row-reset deltas from within-row deltas;
 * a wrong column count mixes the two. Signed deltas catch ramps whose reset
 * reverses direction; magnitudes also catch quantized rows rising then falling.
 * A continuous ramp or uniform block supplies no row-alignment evidence.
 */
function rowAlignmentStrength(bytes: Uint8Array, t: TableCandidate): number {
  const { address, rows, cols, format } = t;
  if (address < 0 || rows < 2 || cols < 2 || address + rows * cols * format.width > bytes.length) return 1;
  let resets = 0, interior = 0, absResets = 0, absInterior = 0, squares = 0;
  let previous = readValue(bytes, address, format);
  for (let i = 1; i < rows * cols; i++) {
    const value = readValue(bytes, address + i * format.width, format);
    const delta = value - previous;
    previous = value;
    squares += delta * delta;
    if (i % cols === 0) {
      resets += delta;
      absResets += Math.abs(delta);
    } else {
      interior += delta;
      absInterior += Math.abs(delta);
    }
  }
  const resetCount = rows - 1, interiorCount = rows * (cols - 1);
  const separation = (resetSum: number, interiorSum: number): number => {
    const total = Math.max(0, squares - (resetSum + interiorSum) ** 2 / (resetCount + interiorCount));
    const residual = Math.max(0, squares - resetSum ** 2 / resetCount - interiorSum ** 2 / interiorCount);
    return total / (residual + 1e-9);
  };
  return Math.max(1, separation(resets, interior), separation(absResets, absInterior));
}

/**
 * 256-byte-bucket index over kept byte spans. `conflicts` is semantically
 * identical to scanning every kept span with overlapFrac (any overlapping
 * pair shares at least one byte, hence at least one bucket) — only the
 * complexity changed (the linear scan was O(kept) per candidate).
 */
class SpanIndex {
  private buckets = new Map<number, Array<[number, number]>>();
  add(span: [number, number]): void {
    for (let b = span[0] >> 8; b <= (span[1] - 1) >> 8; b++) {
      const arr = this.buckets.get(b) ?? [];
      arr.push(span);
      this.buckets.set(b, arr);
    }
  }
  conflicts(span: [number, number], overlapMax: number): boolean {
    const seen = new Set<Array<number>>();
    for (let b = span[0] >> 8; b <= (span[1] - 1) >> 8; b++) {
      const arr = this.buckets.get(b);
      if (!arr) continue;
      for (const s of arr) {
        if (seen.has(s)) continue;
        seen.add(s);
        if (overlapFrac(s as [number, number], span) > overlapMax) return true;
      }
    }
    return false;
  }
}

export function rankAndEmit(
  bytes: Uint8Array,
  candidates: AssociatedTable[],
  axes: AxisCandidate[],
  config: ScanConfig,
  prefixedAxes: PrefixedAxis[] = [],
  familyDetections: FamilyDetection[] = [],
  poolTables: PoolStructTable[] = [],
  curveDetections: FamilyDetection[] = [],
  allowTrendBoundaries = true
): MapDef[] {
  const { wSmooth, wAxis, wDim, overlapMax, minConfidence } = config.score;
  const poolActive = isPoolActive(prefixedAxes, config);
  const pidx = poolActive ? buildPoolIndex(prefixedAxes) : undefined;
  // Structural curve inference consumes the first ranking pass. Keep that
  // input stable; supplementary trend evidence belongs to generic-only scans.
  const genericPool = allowTrendBoundaries && familyDetections.length === 0 && poolTables.length === 0 && curveDetections.length === 0;
  const scored = candidates
    .map((c) => ({
      c,
      confidence: Math.min(
        1,
        wSmooth * c.table.score + wAxis * c.axisFit + wDim * dimPrior(c.table.rows, c.table.cols, config)
      ),
      anchor: undefined as Anchor | undefined,
      poolAnchor: undefined as PoolAnchor | undefined,
      poolTier: false,
      boundary: 0,
      rowAlignment: 1,
      shear: false,
    }))
    .filter((s) => s.confidence >= minConfidence);
  const idx = buildAxisIndex(axes);
  // Anchors, shear, and pool bindings are evaluated only for confidence-gate
  // survivors — pool-wide evaluation would be pure waste.
  for (const s of scored) {
    s.anchor = findAnchor(s.c.table, idx, config, bytes);
    if (s.anchor) s.shear = shearOk(bytes, s.c.table, config);
    if (pidx) {
      s.poolAnchor = findPoolAnchor(s.c.table, pidx, config);
      if (s.poolAnchor) {
        const start = startEdgeStrength(bytes, s.c.table) ?? -Infinity;
        const end = endEdgeStrength(bytes, s.c.table) ?? -Infinity;
        s.boundary = Math.min(start, end);
        s.poolTier = s.c.table.cluster
          ? true // separator-backed cluster candidate: the periodic separator IS the boundary evidence
          : start >= config.pool.edgeMin && end >= config.pool.endEdgeMin;
        if (!s.poolTier && genericPool) {
          const [trendStart, trendEnd] = trendEdges(bytes, s.c.table, config.pool.trendResidualFloor);
          s.poolTier = trendStart >= config.pool.edgeMin && trendEnd >= config.pool.endEdgeMin;
        }
        if (s.poolTier) s.rowAlignment = rowAlignmentStrength(bytes, s.c.table);
      }
    }
  }
  // Rank tiers: pool-anchored+edge (pool-rich bins only) > zero-gap anchored >
  // unanchored. Pool tier prefers aligned row resets, then stronger external
  // boundaries: vertical smoothness alone can favor a shorter column stride.
  // The anchored tier keeps its shear→byte-span order,
  // and the unanchored tier keeps the pre-existing confidence order.
  const tierOf = (s: (typeof scored)[number]): number =>
    s.poolTier ? 2 : s.anchor ? 1 : 0;
  scored.sort((a, b) => {
    const ta = tierOf(a);
    const tb = tierOf(b);
    if (tb !== ta) return tb - ta;
    if (ta === 2 && a.rowAlignment !== b.rowAlignment) return b.rowAlignment - a.rowAlignment;
    if (ta === 2 && a.boundary !== b.boundary) return b.boundary - a.boundary;
    if (ta === 1) {
      const d =
        Number(b.shear) - Number(a.shear) ||
        b.c.table.rows * b.c.table.cols * b.c.table.format.width -
          a.c.table.rows * a.c.table.cols * a.c.table.format.width;
      if (d !== 0) return d;
    }
    return b.confidence - a.confidence || a.c.table.address - b.c.table.address;
  });

  const kept: Array<{ span: [number, number]; def: MapDef }> = [];
  const spans = new SpanIndex();
  // FAMILY TIER (spec §4.6): family detections rank above every byte
  // tier — tier ascending (header > tight-fallback > loose-fallback > scan),
  // then score, then address. They bypass minConfidence (a code-referenced
  // dead table is still a table) and claim spans first in the shared dedup.
  // Sorted here so analyzer output order is not load-bearing; Array.sort is
  // spec-stable, so exact ties (same tier/score/address, different dims)
  // fall back to the analyzer's deterministic emission order.
  // Params (kind 'param', Switch Phase B) are partitioned OUT of the family
  // loop: family claims spans FIRST, params claim spans LAST (weakest claim
  // in the pipeline — see the PARAM TIER block below).
  const paramDetections = familyDetections.filter((f) => f.kind === 'param');
  const family = [...familyDetections]
    .filter((f) => f.kind !== 'param')
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.address - b.address);
  for (const f of family) {
    const span = byteSpan(f);
    if (spans.conflicts(span, overlapMax)) continue;
    const endian = f.format.endianness === 'big' ? 'be' : 'le';
    const def: MapDef = {
      id: `auto-0x${f.address.toString(16)}-${f.rows}x${f.cols}w${f.format.width}${endian}`,
      name: `Map 0x${f.address.toString(16).toUpperCase()} ${f.rows}×${f.cols}`,
      address: f.address,
      rows: f.rows,
      cols: f.cols,
      format: f.format,
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major',
      provenance: 'auto',
      confidence: f.score,
      detector: 'family',
    };
    if (f.xAxis !== undefined) {
      def.xAxis = { kind: 'referenced', address: f.xAxis.address, count: f.xAxis.count, format: f.xAxis.format };
    }
    if (f.yAxis !== undefined) {
      def.yAxis = { kind: 'referenced', address: f.yAxis.address, count: f.yAxis.count, format: f.yAxis.format };
    }
    kept.push({ span, def });
    spans.add(span);
  }
  // POOL-STRUCTURAL TIER (spec §4.4 addendum): adjacency-tight count-prefixed
  // axis pairs define a dead/uniform table's exact start + dims independent of
  // byte-smoothness (poolAdjacentTables). Emitted after the family tier
  // (code-proven ranks highest) and before byte candidates, so a structural
  // placement claims its span ahead of the boundary-clipping byte misframe it
  // corrects. Restricted to uniform regions upstream, so it never displaces a
  // real (non-uniform) byte map. Inert off-pool (poolTables is [] there). Larger
  // tables first so a bigger structural table wins a shared span over a nested
  // smaller one; ties by address for determinism.
  if (poolActive) {
    const pts = [...poolTables].sort(
      (a, b) => b.rows * b.cols - a.rows * a.cols || a.address - b.address
    );
    for (const p of pts) {
      const span = byteSpan(p);
      if (spans.conflicts(span, overlapMax)) continue;
      const endian = p.format.endianness === 'big' ? 'be' : 'le';
      const def: MapDef = {
        id: `auto-0x${p.address.toString(16)}-${p.rows}x${p.cols}w${p.format.width}${endian}`,
        name: `Map 0x${p.address.toString(16).toUpperCase()} ${p.rows}×${p.cols}`,
        address: p.address,
        rows: p.rows,
        cols: p.cols,
        format: p.format,
        scaling: { factor: 1, offset: 0, units: '', digits: 0 },
        orientation: 'row-major',
        provenance: 'auto',
        confidence: config.pool.structConfidence,
        detector: 'structural',
        xAxis: { kind: 'referenced', address: p.xAxis.address, count: p.xAxis.count, format: p.xAxis.format },
        yAxis: { kind: 'referenced', address: p.yAxis.address, count: p.yAxis.count, format: p.yAxis.format },
      };
      kept.push({ span, def });
      spans.add(span);
    }
  }
  // CURVE-DETECTIONS TIER (spec Phase 3, spike docs/notes/ms41-p3-partial-curves-spike.md):
  // partial 1D curves (kind '1d', tier ≥7) emitted immediately after the
  // pool-structural tier and BEFORE byte candidates — the spike MEASURED this
  // placement ('last' collapses curve recall 0.58→0.25: generic byte junk
  // claims the spans first). Empty-guard keeps every existing caller
  // byte-identical. Not additionally guarded by poolActive (unlike the
  // pool-structural tier above): the sole producer, scan()'s
  // poolStructuralActive gate, already implies it — a non-empty list here is
  // pool-active by construction. Deterministic total order: tier asc
  // (future-proof), address asc, rows desc, width asc (the integ harness's
  // order).
  if (curveDetections.length > 0) {
    const sorted = [...curveDetections].sort(
      (a, b) => a.tier - b.tier || a.address - b.address || b.rows - a.rows || a.format.width - b.format.width
    );
    for (const f of sorted) {
      const span = byteSpan(f);
      if (spans.conflicts(span, overlapMax)) continue;
      const endian = f.format.endianness === 'big' ? 'be' : 'le';
      const def: MapDef = {
        id: `auto-0x${f.address.toString(16)}-${f.rows}x${f.cols}w${f.format.width}${endian}`,
        name: `Map 0x${f.address.toString(16).toUpperCase()} ${f.rows}×${f.cols}`,
        address: f.address,
        rows: f.rows,
        cols: f.cols,
        format: f.format,
        scaling: { factor: 1, offset: 0, units: '', digits: 0 },
        orientation: 'row-major',
        provenance: 'auto',
        confidence: f.score,
        detector: 'structural',
      };
      if (f.yAxis !== undefined) {
        def.yAxis = { kind: 'referenced', address: f.yAxis.address, count: f.yAxis.count, format: f.yAxis.format };
      }
      kept.push({ span, def });
      spans.add(span);
    }
  }
  // Structural maps and their axes own their bytes before generic guesses and
  // scalar reads. Generic shapes do not suppress code-read scalars.
  const protectedSpans = new SpanIndex();
  for (const { span, def } of kept) {
    protectedSpans.add(span);
    for (const axis of [def.xAxis, def.yAxis]) {
      if (axis?.kind === 'referenced' && axis.address !== undefined && axis.format !== undefined) {
        protectedSpans.add([axis.address, axis.address + axis.count * axis.format.width]);
      }
    }
  }
  for (const { c, confidence, anchor, poolAnchor } of scored) {
    const span = byteSpan(c.table);
    if (spans.conflicts(span, overlapMax) || protectedSpans.conflicts(span, overlapMax)) continue;
    const { address, rows, cols, format } = c.table;
    const endian = format.endianness === 'big' ? 'be' : 'le';
    const def: MapDef = {
      id: `auto-0x${address.toString(16)}-${rows}x${cols}w${format.width}${endian}`,
      name: `Map 0x${address.toString(16).toUpperCase()} ${rows}×${cols}`,
      address,
      rows,
      cols,
      format,
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major',
      provenance: 'auto',
      confidence,
      detector: poolActive && poolAnchor ? 'pool' : 'generic',
    };
    // Pool mode active → the RAW pool binding wins emission even where a
    // zero-gap anchor exists: on pool-layout bins those anchors are always
    // carved coincidences (measured: axis recall 0.00 without this rule).
    let x: AxisDef | undefined;
    let y: AxisDef | undefined;
    if (poolActive && poolAnchor) {
      x = { kind: 'referenced', address: poolAnchor.x.address, count: poolAnchor.x.count, format: poolAnchor.x.format };
      y = { kind: 'referenced', address: poolAnchor.y.address, count: poolAnchor.y.count, format: poolAnchor.y.format };
    } else if (anchor) {
      x = { kind: 'referenced', address: anchor.xAddress, count: anchor.xCount, format: anchor.xFormat };
      y = { kind: 'referenced', address: anchor.yAddress, count: anchor.yCount, format: anchor.yFormat };
    } else {
      x = toAxisDef(c.xAxis);
      y = toAxisDef(c.yAxis);
    }
    if (x) def.xAxis = x;
    if (y) def.yAxis = y;
    kept.push({ span, def });
    spans.add(span);
  }
  // PARAM TIER (spec 2026-07-23 Switch Phase B): code-referenced 1×1
  // parameters are emitted LAST without displacing any existing table.
  // Structural maps suppress overlapping scalar reads; generic guesses do not.
  // Emitting last also makes every existing row byte-identical BY
  // CONSTRUCTION (append-only). Deterministic order: address asc, width asc.
  // NOTE: this loop suppresses against spans added by EARLIER tiers AND by
  // earlier iterations of itself — a wider param can suppress a narrower one
  // at an overlapping address (the address/width sort makes this
  // deterministic), so params also participate in the add-discipline among
  // themselves, not only against other tiers.
  if (paramDetections.length > 0) {
    const sorted = [...paramDetections].sort(
      (a, b) => a.address - b.address || a.format.width - b.format.width
    );
    for (const f of sorted) {
      const span = byteSpan(f);
      // States-bearing params are EXEMPT from suppression (plan Decision 10,
      // user-adjudicated after the dry-run measured the subclass collapsing
      // 7 -> 1 per bin): a code-tested switch byte inside a heuristic byte
      // map is evidence that map is misframed, and this tier's audience is
      // bins with no definition file. Append-only is unaffected — params are
      // emitted last, so an exempt param adds a row without moving one.
      if (f.states === undefined && protectedSpans.conflicts(span, overlapMax)) continue;
      const endian = f.format.endianness === 'big' ? 'be' : 'le';
      const def: MapDef = {
        id: `auto-0x${f.address.toString(16)}-1x1w${f.format.width}${endian}`,
        name: `Param 0x${f.address.toString(16).toUpperCase()} ${f.format.signed ? 'i' : 'u'}${f.format.width * 8}`,
        category: 'Code-referenced parameter',
        address: f.address,
        rows: f.rows,
        cols: f.cols,
        format: f.format,
        scaling: { factor: 1, offset: 0, units: '', digits: 0 },
        orientation: 'row-major',
        provenance: 'auto',
        confidence: f.score,
        detector: 'family',
      };
      if (f.states !== undefined) def.states = f.states;
      kept.push({ span, def });
      protectedSpans.add(span);
    }
  }
  return kept.map(({ def }) => {
    // Curve axes can be intentionally constant in inactive calibrations.
    if (def.rows === 1 || def.cols === 1) return def;
    // Constant grid runs can establish dimensions, but supply no coordinates.
    // Keep their byte ownership above and let views use indices instead.
    for (const key of ['xAxis', 'yAxis'] as const) {
      const axis = def[key];
      if (axis?.kind !== 'referenced' || axis.count < 2) continue;
      const values = readAxisValues(bytes, axis);
      if (values.every(v => v === values[0])) delete def[key];
    }
    return def;
  });
}
