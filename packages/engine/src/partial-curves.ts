import type { MapDef, ValueFormat } from '@binanalyzer/core';
import type { ScanConfig } from './config.js';
import type { PrefixedAxis } from './pool.js';
import type { FamilyDetection } from './family/types.js';

/**
 * Partial 1D-curve detection — trusted-structure tiling discriminator
 * (Phase 3, spike docs/notes/ms41-p3-partial-curves-spike.md; transcribed
 * from the spike's FINAL ladder stack, 3-lens adversarially verified).
 *
 * On a direct-SA cal partial the full-read curve gate (code-xref) does not
 * exist — curve-vs-axis separation is carried instead by the structure the
 * grid detectors already TRUSTED: a 2-byte backward-header candidate
 * `[axisPtr u16LE][data]` is accepted only when its block tiles the free
 * space between known structures and is ANCHORED to one of their edges.
 *
 * Components (all measured; the spike header records the REJECTED variants —
 * F-panchor breaks the synth gate, F-wanchor/F-sliver/F-selfK flood junk —
 * do not reintroduce them):
 *  - typed spans: trusted grid emissions (detector 'structural'|'pool') with
 *    their 4-byte headers and referenced axes, plus maximal pooled axes —
 *    TYPED, not merged, so per-span rules apply.
 *  - F-own: a pool/refaxis span the candidate's ptr points INTO is its own
 *    axis, never a veto.
 *  - F-ptrim / F-ptrim2: pool runs overshooting into a curve block (from
 *    before it, or starting inside it) are trims, not vetoes.
 *  - F-glegit + F-refdem: a trusted grid vetoes only if its own 4-byte header
 *    re-validates as two backward axis ptrs matching its dims; demoted grids
 *    (and their referenced-axis spans) stop vetoing. Demotion is LOCAL to
 *    this discriminator — grid EMISSIONS are never suppressed.
 *  - F-gchain2: a legit grid's over-reach is waived only for a back-to-back
 *    candidate chain from a row-aligned trim point (>= 2 rows remain) through
 *    the vetoed block to at/past the grid end, stepping only through
 *    candidates free modulo this same grid.
 *  - F-comp closure with F-pad: candidates union into exact-tiling chain
 *    components (end == next start); a component is kept only if some member
 *    touches a trusted edge. A block whose end is ODD may be followed by one
 *    pad byte (C166 word alignment) — links and edge matches accept end+1.
 *  - F-adjax: `[n][axis][hdr][data]` contiguous (the SS1v2 adjacent-axis
 *    curve layout) self-anchors.
 *  - contained-span rule (transcription-faithful, unnamed in the ladder): a
 *    trusted span FULLY CONTAINED in the candidate block never vetoes it. For
 *    emissions this is harmless by construction — a contained structural/pool
 *    table emits first and span-conflicts the curve away in rankAndEmit.
 *
 * Pure and deterministic: consumes the FIRST-pass emitted maps + prefixed
 * axes (the caller re-runs rankAndEmit with the result — the spike measured
 * the two-pass shape as NOT single-pass-equivalent). Inert wherever the
 * caller's gate (poolStructuralActive) is off, and EMPIRICALLY zero on the
 * committed synth-partials (pinned in test).
 */

/** Structural FACT: the 24KB MS41 cal window — the sweep/axis bound on a
 *  direct-SA partial (offset == storageaddress inside it). */
const CURVE_PARTIAL_END = 0x6000;
/** Emission tier: below all grid tiers (0-3) and the full-read curve tiers
 *  (4/5/6) — a partial curve must never displace stronger evidence. */
const CURVE_PARTIAL_TIER = 7;
/** Structural FACT: C166 word-alignment pad — an odd block end may be
 *  followed by exactly 1 pad byte before the next structure. */
const PAD = 1;
/** Structural FACT: a grid-chain trim must leave >= this many rows of the
 *  grid standing (a shorter remnant is not a plausible grid). */
const CHAIN_MIN_ROWS = 2;
/** F-glegit's axis-count floor when RE-VALIDATING a trusted grid's own 4-byte
 *  header (the spike ladder's hardcoded value). Deliberately independent of
 *  config.pool.curvePartialMinCount — the CANDIDATE sweep's floor is a tuning
 *  knob; this one asks "is the header a real MS41 [xPtr][yPtr] pair", the
 *  same question structHeaderAxisMinCount answers for the structural
 *  detector, and 2 admits the real 3-count stock axes there too. */
const GRID_HEADER_REVALIDATE_MIN_COUNT = 2;
/** Emission tier for the P3.1-S1 HEADERLESS overlay: strictly below the
 *  tier-7 backward-header sweep — Q-B-measured 25% emission precision is a
 *  weaker evidence class than everything above it. */
const CURVE_HEADLESS_TIER = 8;
/** Parse-veto floor (S1): a candidate block whose own bytes parse as a strict
 *  count-prefixed monotone axis run IS an axis pattern — kill the candidate.
 *  PINNED at 2, deliberately INDEPENDENT of config.pool.curveHeadlessMinCount:
 *  the spike measured that raising the candidate floor to 4 WEAKENED the veto
 *  (junk went UP) — the veto asks "is this axis-like at all", not "is this a
 *  valid candidate axis". */
const HEADLESS_PARSE_VETO_MIN_COUNT = 2;

const U8: ValueFormat = { width: 1, signed: false, endianness: 'big' };
const U16LE: ValueFormat = { width: 2, signed: false, endianness: 'little' };
const fmtOf = (w: 1 | 2): ValueFormat => (w === 1 ? U8 : U16LE);
const u8 = (b: Uint8Array, p: number): number => b[p]!;
const u16 = (b: Uint8Array, p: number): number => b[p]! | (b[p + 1]! << 8);

interface Ax { ptr: number; dataP: number; count: number; width: 1 | 2 }

/** Count-prefixed strictly-monotone axis at `ptr` (u8 count first, then u16LE). */
function axAt(b: Uint8Array, ptr: number, minCount: number, maxCount: number): Ax | undefined {
  if (ptr < 4 || ptr > CURVE_PARTIAL_END - 4) return undefined;
  for (const width of [1, 2] as const) {
    const count = width === 1 ? u8(b, ptr) : u16(b, ptr);
    if (count < minCount || count > maxCount) continue;
    const dataP = ptr + width;
    if (dataP + count * width > Math.min(CURVE_PARTIAL_END, b.length)) continue;
    const cell = (i: number): number => (width === 1 ? u8(b, dataP + i) : u16(b, dataP + i * 2));
    let dir = 0;
    let ok = true;
    for (let i = 1; i < count; i++) {
      const d = Math.sign(cell(i) - cell(i - 1));
      if (d === 0 || (dir !== 0 && d !== dir)) { ok = false; break; }
      dir = d;
    }
    if (ok) return { ptr, dataP, count, width };
  }
  return undefined;
}

/** Every p with a valid backward 2-byte header: u16le[p-2] < p → axis. */
function sweepCandidates(b: Uint8Array, minCount: number, maxCount: number): Map<number, Ax> {
  const out = new Map<number, Ax>();
  for (let p = 6; p < Math.min(CURVE_PARTIAL_END, b.length); p++) {
    const ptr = u16(b, p - 2);
    if (ptr >= p) continue;
    const ax = axAt(b, ptr, minCount, maxCount);
    if (ax) out.set(p, ax);
  }
  return out;
}

interface TSpan {
  s: number;
  e: number;
  type: 'grid' | 'refaxis' | 'pool';
  dataS?: number;
  rowStride?: number;
  rows?: number;
  cols?: number;
  parent?: TSpan; // refaxis → owning grid (F-refdem)
  /** Axis identity (data address / count / cell width) for pool and refaxis
   *  spans — the S1 headerless overlay's trusted-axis key. Unset on grids. */
  axAddr?: number;
  axCount?: number;
  axW?: number;
}

/** Typed trusted spans from the FIRST-pass emissions + maximal pooled axes. */
function typedSpans(emittedMaps: MapDef[], prefixed: PrefixedAxis[]): TSpan[] {
  const spans: TSpan[] = [];
  for (const m of emittedMaps) {
    if (m.detector !== 'structural' && m.detector !== 'pool') continue;
    const dataS = m.address;
    const e = dataS + m.rows * m.cols * m.format.width;
    const g: TSpan = {
      s: dataS - 4 >= 0 ? dataS - 4 : dataS, e, type: 'grid',
      dataS, rowStride: m.cols * m.format.width, rows: m.rows, cols: m.cols,
    };
    spans.push(g);
    for (const a of [m.xAxis, m.yAxis]) {
      if (a?.kind === 'referenced' && a.address !== undefined && a.format !== undefined) {
        spans.push({
          s: a.address - a.format.width, e: a.address + a.count * a.format.width, type: 'refaxis', parent: g,
          axAddr: a.address, axCount: a.count, axW: a.format.width,
        });
      }
    }
  }
  for (const a of prefixed) {
    if (!a.maximal) continue;
    spans.push({
      s: a.address - a.format.width, e: a.address + a.count * a.format.width, type: 'pool',
      axAddr: a.address, axCount: a.count, axW: a.format.width,
    });
  }
  return spans.sort((x, y) => x.s - y.s);
}

function merged(spans: TSpan[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const sp of spans) {
    const last = out[out.length - 1];
    if (last && sp.s <= last[1]) last[1] = Math.max(last[1], sp.e);
    else out.push([sp.s, sp.e]);
  }
  return out;
}

/** F-glegit: a real MS41 grid header = two backward axis ptrs matching dims. */
function gridLegit(b: Uint8Array, g: TSpan, maxCount: number): boolean {
  if (g.type !== 'grid' || g.dataS === undefined || g.rows === undefined || g.cols === undefined) return true;
  if (g.dataS < 4) return true;
  const h0 = u16(b, g.dataS - 4);
  const h1 = u16(b, g.dataS - 2);
  const a0 = h0 < g.dataS - 4 ? axAt(b, h0, GRID_HEADER_REVALIDATE_MIN_COUNT, maxCount) : undefined;
  const a1 = h1 < g.dataS - 4 ? axAt(b, h1, GRID_HEADER_REVALIDATE_MIN_COUNT, maxCount) : undefined;
  const m = (a: Ax | undefined, n: number): boolean => a !== undefined && a.count === n;
  return (m(a0, g.cols) && m(a1, g.rows)) || (m(a0, g.rows) && m(a1, g.cols));
}

/** Demoted spans: illegit grids + their referenced-axis spans (F-refdem). */
function computeDemoted(b: Uint8Array, spans: TSpan[], maxCount: number): Set<TSpan> {
  const out = new Set<TSpan>();
  for (const g of spans) if (g.type === 'grid' && !gridLegit(b, g, maxCount)) out.add(g);
  for (const sp of spans) if (sp.type === 'refaxis' && sp.parent !== undefined && out.has(sp.parent)) out.add(sp);
  return out;
}

type VetStatus = TSpan[] | 'oob';

/** Veto spans for block [p-2, p+count*w) under the FINAL per-span rules
 *  (F-own, F-ptrim, F-ptrim2, demotion) — everything except the grid-chain
 *  waiver, which the caller applies on the residue. */
function baseVetoes(b: Uint8Array, p: number, ax: Ax, w: 1 | 2, spans: TSpan[], demoted: Set<TSpan>): VetStatus {
  const s = p - 2;
  const e = p + ax.count * w;
  if (e > Math.min(CURVE_PARTIAL_END, b.length)) return 'oob';
  const out: TSpan[] = [];
  for (const sp of spans) {
    if (demoted.has(sp)) continue;
    if (!(sp.s < e && s < sp.e)) continue;
    if (sp.s >= s && sp.e <= e) continue;
    if ((sp.type === 'pool' || sp.type === 'refaxis') && ax.ptr >= sp.s && ax.ptr < sp.e) continue; // F-own
    if (sp.type === 'pool' && sp.s < s) continue; // F-ptrim
    if (sp.type === 'pool' && sp.s >= s && sp.s < e) continue; // F-ptrim2
    out.push(sp);
  }
  return out;
}

/**
 * The discriminator. `emittedMaps` are the FIRST-pass `scan()` emissions
 * (only detector 'structural'|'pool' are trusted); `prefixed` the bin's
 * prefixed-axis scan (only maximal runs are trusted). Returns kind-'1d'
 * tier-7 detections: rows = pointed-axis count, cols 1, yAxis identity-framed
 * (dataP IS the file offset on a direct-SA partial).
 */
export function partialCurveDetections(
  bytes: Uint8Array,
  emittedMaps: MapDef[],
  prefixed: PrefixedAxis[],
  config: ScanConfig
): FamilyDetection[] {
  const minCount = config.pool.curvePartialMinCount;
  const maxCount = config.axis.maxCount;
  const cap = Math.min(CURVE_PARTIAL_END, bytes.length);

  const spans = typedSpans(emittedMaps, prefixed);
  const demoted = computeDemoted(bytes, spans, maxCount);
  const cands = sweepCandidates(bytes, minCount, maxCount);

  // trusted edges: merged extents of the NON-demoted spans
  const eff = spans.filter((sp) => !demoted.has(sp));
  const edgeSet = new Set<number>();
  for (const [a, e] of merged(eff)) { edgeSet.add(a); edgeSet.add(e); }
  const candStarts = new Set<number>([...cands.keys()].map((p) => p - 2));

  // pre-vetoes per candidate per width
  const preVet = new Map<number, [VetStatus, VetStatus]>();
  for (const [p, ax] of cands) {
    preVet.set(p, [baseVetoes(bytes, p, ax, 1, spans, demoted), baseVetoes(bytes, p, ax, 2, spans, demoted)]);
  }

  // F-gchain2: chain step restricted to candidates free MODULO grid g
  const stepModG = (x: number, g: TSpan): number[] => {
    const ax = cands.get(x + 2);
    if (!ax) return [];
    const pv = preVet.get(x + 2)!;
    const out: number[] = [];
    for (const w of [1, 2] as const) {
      const st = w === 1 ? pv[0] : pv[1];
      if (st === 'oob') continue;
      if (st.every((sp) => sp === g)) out.push(x + 2 + ax.count * w);
    }
    return out;
  };
  const reachesExactModG = (from: number, target: number, g: TSpan): boolean => {
    const stack = [from];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const x = stack.pop()!;
      if (x === target) return true;
      if (x > target || x > cap || seen.has(x)) continue;
      seen.add(x);
      for (const n of stepModG(x, g)) if (n <= target) stack.push(n);
    }
    return false;
  };
  const reachesAtLeastModG = (from: number, target: number, g: TSpan): boolean => {
    const stack = [from];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const x = stack.pop()!;
      if (x >= target) return true;
      if (x > cap || seen.has(x)) continue;
      seen.add(x);
      stack.push(...stepModG(x, g));
    }
    return false;
  };
  const waiveMemo = new Map<string, boolean>();
  const waived = (g: TSpan, s: number): boolean => {
    if (g.type !== 'grid' || g.dataS === undefined || g.rowStride === undefined || g.rowStride <= 0) return false;
    if (!(g.s < s && s > g.dataS)) return false;
    const key = `${g.dataS}|${s}`;
    const hit = waiveMemo.get(key);
    if (hit !== undefined) return hit;
    let ok = false;
    if (reachesAtLeastModG(s, g.e, g)) {
      const kMax = Math.floor((s - g.dataS) / g.rowStride);
      for (let k = kMax; k >= CHAIN_MIN_ROWS; k--) {
        const t = g.dataS + k * g.rowStride;
        if (t > s) continue;
        if (reachesExactModG(t, s, g)) { ok = true; break; }
      }
    }
    waiveMemo.set(key, ok);
    return ok;
  };

  // feasible widths per candidate: free, or vetoed only by chain-waived grids
  const feas = new Map<number, Array<1 | 2>>();
  for (const [p, ax] of cands) {
    const pv = preVet.get(p)!;
    const ws: Array<1 | 2> = [];
    for (const w of [1, 2] as const) {
      const st = w === 1 ? pv[0] : pv[1];
      if (st === 'oob') continue;
      if (st.length === 0) { ws.push(w); continue; }
      if (st.every((sp) => sp.type === 'grid' && waived(sp, p - 2))) ws.push(w);
    }
    if (ws.length > 0) feas.set(p, ws);
  }

  // F-pad edge matching: an odd end also matches an anchor at end+1; a start
  // also matches an anchor at start-1 when that is odd.
  const startMatch = (set: Set<number>, s: number): boolean =>
    set.has(s) || ((s - PAD) % 2 === 1 && set.has(s - PAD));
  const endMatch = (set: Set<number>, e: number): boolean =>
    set.has(e) || (e % 2 === 1 && set.has(e + PAD));
  // F-adjax: the ptr'd axis (count prefix included) ends exactly at the block start.
  const adjAnchored = (p: number): boolean => {
    const ax = cands.get(p)!;
    return ax.ptr + ax.width * (ax.count + 1) === p - 2;
  };

  // F-comp closure: union candidates into exact-tiling chain components
  // (block end == next block start, pad-tolerant); keep a component only if
  // some member touches a trusted edge or self-anchors.
  const nodes = [...feas.keys()];
  const idx = new Map<number, number>(nodes.map((p, i) => [p, i]));
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  };
  const union = (i: number, j: number): void => {
    const a = find(i);
    const b2 = find(j);
    if (a !== b2) parent[a] = b2;
  };
  const startIdx = new Map<number, number>();
  for (const p of nodes) startIdx.set(p - 2, idx.get(p)!);
  for (const p of nodes) {
    const ax = cands.get(p)!;
    for (const w of feas.get(p)!) {
      const e = p + ax.count * w;
      const j = startIdx.get(e) ?? (e % 2 === 1 ? startIdx.get(e + PAD) : undefined);
      if (j !== undefined) union(idx.get(p)!, j);
    }
  }
  const compAnchored = new Map<number, boolean>();
  for (const p of nodes) {
    const r = find(idx.get(p)!);
    const ax = cands.get(p)!;
    let anchored = startMatch(edgeSet, p - 2) || adjAnchored(p);
    for (const w of feas.get(p)!) {
      if (endMatch(edgeSet, p + ax.count * w)) anchored = true;
    }
    if (anchored) compAnchored.set(r, true);
  }

  // Emission: one detection per passing candidate. Width pick (the integ
  // harness's deterministic rule): exact end-packing first (block end lands
  // on a trusted edge or the next candidate's start), then the smaller width.
  // Deliberately EXACT — not the pad-tolerant endMatch used for anchoring:
  // the picker resolves w1-vs-w2 by literal packing, and a pad-forgiving
  // variant was never measured (the anchor and the picker answer different
  // questions).
  const out: FamilyDetection[] = [];
  for (const p of nodes) {
    if (compAnchored.get(find(idx.get(p)!)) !== true) continue;
    const ax = cands.get(p)!;
    const ws = feas.get(p)!;
    const endAbut = ws.filter((w) => edgeSet.has(p + ax.count * w) || candStarts.has(p + ax.count * w));
    const w = (endAbut.length > 0 ? endAbut : ws)[0]!; // arrays ascend: smaller width wins ties
    out.push({
      address: p,
      rows: ax.count,
      cols: 1,
      format: fmtOf(w),
      score: config.pool.curvePartialConfidence,
      tier: CURVE_PARTIAL_TIER,
      kind: '1d',
      yAxis: { address: ax.dataP, count: ax.count, format: fmtOf(ax.width) },
    });
  }
  out.sort((a, b) => a.address - b.address || b.rows - a.rows || a.format.width - b.format.width);
  return out;
}

interface HeadlessCand {
  p: number;
  c: number;
  ws: Array<1 | 2>;
  axDataP: number;
  axW: 1 | 2;
  pS: number[];
  pEFor: (w: 1 | 2) => number[];
}

/**
 * P3.1-S1 HEADERLESS overlay (spike docs/notes/ms41-p31-headerless-spike.md;
 * EXACT transcription of scratch/spike-p31-final.ts s1() — the function that
 * produced every pinned number. The spike ladder's extra
 * passed-sweep-position/passBlocks skips are deliberately NOT kept: they were
 * a different harness, and the pinned real-hit/emission sets come from THIS
 * semantics).
 *
 * Recovers curves with NO backward header at all: a strictly-free block in
 * fwd/rev strict adjacency to an already-TRUSTED axis span (pool or refaxis),
 * closed on BOTH sides (sandwich) against trusted edges via exact tiling
 * through the shipped feasible-sweep bridges. Components, all measured — the
 * spike records the REJECTED variants (single-sided anchoring is synth-FATAL,
 * any-ax floods junk, trim excuses read [axis][axis] as [axis][curve]); do
 * not reintroduce them:
 *  - trusted-axis-only candidates (the pointed axis must BE a live pool or
 *    refaxis span — identity match on data address/count/width);
 *  - STRICTLY-free blocks (no F-ptrim/ptrim2/gchain excuses);
 *  - own-adjax skip (the [n][axis][hdr][data] layout is tier-7's);
 *  - rev skipped when ANY sweep candidate references the axis;
 *  - parse-veto at the structural floor (HEADLESS_PARSE_VETO_MIN_COUNT);
 *  - rev per-axis width DEDUP: smallest feasible width only (the w2 twin
 *    starts 2·c earlier and would claim the span FIRST, blocking the real
 *    w1 hit — 0x3583 would have blocked GT 0x358d);
 *  - sandwich closure sharing the shipped bridges (baseVetoes-free sweep
 *    candidates), pad-tolerant on odd ends (C166 word alignment).
 *
 * Same wiring contract as partialCurveDetections: consumes FIRST-pass maps0
 * + prefixed axes (NEVER second-pass output — its 1d emissions carry detector
 * 'structural' and are neutralized only by the incidental cols-1 demotion);
 * caller appends the result AFTER the tier-7 detections for the second
 * rankAndEmit pass. Empirically ZERO on every committed + holdout synthetic
 * (pinned in test).
 */
export function headlessCurveDetections(
  bytes: Uint8Array,
  emittedMaps: MapDef[],
  prefixed: PrefixedAxis[],
  config: ScanConfig
): FamilyDetection[] {
  const minCount = config.pool.curveHeadlessMinCount;
  const maxCount = config.axis.maxCount;
  const cap = Math.min(CURVE_PARTIAL_END, bytes.length);

  const spans = typedSpans(emittedMaps, prefixed);
  const demoted = computeDemoted(bytes, spans, maxCount);
  const eff = spans.filter((sp) => !demoted.has(sp));
  const edgeSet = new Set<number>();
  for (const [a, e] of merged(eff)) { edgeSet.add(a); edgeSet.add(e); }

  // shipped feasible-sweep bridges + rev-suppression set — the tier-7 sweep's
  // candidate floor, NOT the headerless floor (S1 shares the shipped bridges)
  const cands = sweepCandidates(bytes, config.pool.curvePartialMinCount, maxCount);
  const sweepRefAxes = new Set<number>();
  for (const ax of cands.values()) sweepRefAxes.add(ax.ptr);

  const trustedAx = new Set<string>();
  for (const sp of eff) {
    if ((sp.type === 'pool' || sp.type === 'refaxis') && sp.axAddr !== undefined) {
      trustedAx.add(`${sp.axAddr}|${sp.axCount}|${sp.axW}`);
    }
  }

  const hs: HeadlessCand[] = [];
  // STRICTLY-free: any live-span overlap vetoes — no trim/chain excuses.
  const blockFree = (s: number, e: number): boolean => {
    if (e > cap) return false;
    for (const sp of eff) if (sp.s < e && s < sp.e) return false;
    return true;
  };
  for (let q = 4; q < cap - 4; q++) {
    const ax = axAt(bytes, q, minCount, maxCount);
    if (!ax) continue;
    if (!trustedAx.has(`${ax.dataP}|${ax.count}|${ax.width}`)) continue;
    const axEnd = ax.dataP + ax.count * ax.width;
    // fwd: block starts exactly at the trusted axis's end
    {
      const p = axEnd;
      const ownAdjax = u16(bytes, p) === ax.ptr;
      const parseHit = axAt(bytes, p, HEADLESS_PARSE_VETO_MIN_COUNT, maxCount) !== undefined;
      if (!ownAdjax && !parseHit && p + ax.count <= cap) {
        const ws = ([1, 2] as const).filter((w) => blockFree(p, p + ax.count * w));
        if (ws.length > 0) {
          hs.push({
            p, c: ax.count, ws: [...ws], axDataP: ax.dataP, axW: ax.width,
            pS: [...new Set([p, ax.ptr])], pEFor: (w) => [p + ax.count * w],
          });
        }
      }
    }
    // rev: block ends exactly at the trusted axis's count prefix
    if (!sweepRefAxes.has(ax.ptr)) {
      for (const w of [1, 2] as const) {
        const p = ax.ptr - ax.count * w;
        if (p < 0) continue;
        if (axAt(bytes, p, HEADLESS_PARSE_VETO_MIN_COUNT, maxCount) !== undefined) continue; // parse-veto
        if (!blockFree(p, ax.ptr)) continue;
        hs.push({
          p, c: ax.count, ws: [w], axDataP: ax.dataP, axW: ax.width,
          pS: [p], pEFor: () => [ax.ptr, ax.dataP + ax.count * ax.width],
        });
        break; // width dedup: keep only the smallest feasible width per axis
      }
    }
  }

  // Sandwich (BOTH-sided) closure over headerless candidates + bridges.
  interface Node { starts: number[]; ends: number[]; h?: HeadlessCand }
  const nodes: Node[] = hs.map((h) => ({ starts: h.pS, ends: [...new Set(h.ws.flatMap((w) => h.pEFor(w)))], h }));
  for (const [p, ax] of cands) {
    const ws: Array<1 | 2> = [];
    for (const w of [1, 2] as const) {
      const st = baseVetoes(bytes, p, ax, w, spans, demoted);
      if (st !== 'oob' && st.length === 0) ws.push(w); // strictly veto-free — NO grid-chain waiver here
    }
    if (ws.length > 0) nodes.push({ starts: [p - 2], ends: ws.map((w) => p + ax.count * w) });
  }
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  };
  const union = (i: number, j: number): void => {
    const a = find(i);
    const b2 = find(j);
    if (a !== b2) parent[a] = b2;
  };
  const byStart = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    for (const s of n.starts) {
      const l = byStart.get(s) ?? [];
      l.push(i);
      byStart.set(s, l);
    }
  });
  nodes.forEach((n, i) => {
    for (const e of n.ends) {
      for (const j of byStart.get(e) ?? []) union(i, j);
      if (e % 2 === 1) for (const j of byStart.get(e + PAD) ?? []) union(i, j);
    }
  });
  const sM = (s: number): boolean => edgeSet.has(s) || ((s - PAD) % 2 === 1 && edgeSet.has(s - PAD));
  const eM = (e: number): boolean => edgeSet.has(e) || (e % 2 === 1 && edgeSet.has(e + PAD));
  const compS = new Map<number, boolean>();
  const compE = new Map<number, boolean>();
  nodes.forEach((n, i) => {
    const r = find(i);
    if (n.starts.some(sM)) compS.set(r, true);
    if (n.ends.some(eM)) compE.set(r, true);
  });

  const out: FamilyDetection[] = [];
  const seen = new Set<number>();
  nodes.forEach((n, i) => {
    if (!n.h) return;
    const r = find(i);
    if (!(compS.get(r) === true && compE.get(r) === true)) return;
    if (seen.has(n.h.p)) return;
    seen.add(n.h.p);
    const endAbut = n.h.ws.filter((w) => n.h!.pEFor(w).some((e) => edgeSet.has(e) || byStart.has(e)));
    const w = (endAbut.length > 0 ? endAbut : n.h.ws)[0]!;
    out.push({
      address: n.h.p,
      rows: n.h.c,
      cols: 1,
      format: fmtOf(w),
      score: config.pool.curveHeadlessConfidence,
      tier: CURVE_HEADLESS_TIER,
      kind: '1d',
      yAxis: { address: n.h.axDataP, count: n.h.c, format: fmtOf(n.h.axW) },
    });
  });
  out.sort((a, b) => a.address - b.address);
  return out;
}
