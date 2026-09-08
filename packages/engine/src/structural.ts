import { readValue } from '@binanalyzer/core';
import type { ValueFormat } from '@binanalyzer/core';
import type { ScanConfig } from './config.js';
import { isPoolActive, type PrefixedAxis, type PoolStructTable } from './pool.js';
import { colTvAt } from './tables.js';

/**
 * Partial-structural table detection (spec §4.4, code-free MS4x path).
 *
 * On a cal PARTIAL (< STRUCT_MAX_BIN_LEN) a storageaddress equals its file
 * offset — the 256KB full read's A13/A14 bank scramble does not apply — so a
 * table's 4-byte header `[xPtr u16LE][yPtr u16LE]` (pointing at its axes' count
 * prefixes) decodes directly, with NO saToFo and NO code region. This module is
 * self-contained: it re-encodes the direct-SA decode and MUST NOT import the
 * family module (which is saToFo-framed for full reads). The header byte-order,
 * u16 LE width, and plateau-tail axis law are MEASURED MS41 conventions — a
 * non-MS41 direct-framed bin is out-of-distribution.
 */

/** Structural FACT: only small direct-framed bins (partials) are decoded here.
 *  A 256KB full read has file != SA and is owned by the family tier; the ceiling
 *  makes full-read safety STRUCTURAL (not merely the empirical header count) and
 *  bounds the tiling's work. Equals MS41_MIN_BIN_LEN. */
export const STRUCT_MAX_BIN_LEN = 0x18000;
/** Defensive cap on tiling steps per pair (structural fact; bounds work). */
const STRUCT_TILE_MAX_STEPS = 64;

const U8: ValueFormat = { width: 1, signed: false, endianness: 'big' };
const U16LE: ValueFormat = { width: 2, signed: false, endianness: 'little' };
const fmtOf = (w: 1 | 2): ValueFormat => (w === 1 ? U8 : U16LE);
const r16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);

type AxisKind = 'strict' | 'plateau' | 'dead';
interface AxisRun { count: number; width: 1 | 2; kind: AxisKind; dataAddr: number; end: number; strictLen: number; }

/**
 * Validate a file-offset pointer as a count-prefixed axis run. Reads the count
 * at `ptr` (word preferred when it ends at the next axis prefix) and requires
 * `count in [minCount, maxCount]`, the cell run in-bounds, and cells strictly monotone — optionally
 * (relaxed) followed by a constant plateau tail (count includes the tail), or
 * all-equal ('dead', measured on zero-filled MAF axes). Direct offsets only.
 */
function validateAxisAt(bytes: Uint8Array, ptr: number, minCount: number, maxCount: number, relaxed: boolean, nextPtr?: number): AxisRun | undefined {
  if (ptr < 0 || ptr > bytes.length - 2) return undefined;
  const widths: readonly (1 | 2)[] = ptr + 2 + r16(bytes, ptr) * 2 === nextPtr ? [2, 1] : [1, 2];
  for (const width of widths) {
    const count = width === 1 ? bytes[ptr]! : r16(bytes, ptr);
    if (count < minCount || count > maxCount) continue;
    const dataAddr = ptr + width;
    if (dataAddr + count * width > bytes.length) continue;
    const cell = (i: number): number => (width === 1 ? bytes[dataAddr + i]! : r16(bytes, dataAddr + i * 2));
    let dir = 0;
    let strictLen = 1;
    let broke = false;
    for (let i = 1; i < count; i++) {
      const d = Math.sign(cell(i) - cell(i - 1));
      if (d === 0) { strictLen = i; break; }
      if (dir !== 0 && d !== dir) { broke = true; break; }
      dir = d;
      strictLen = i + 1;
    }
    if (broke) continue;
    let tailOk = true;
    for (let i = strictLen; i < count; i++) if (cell(i) !== cell(strictLen - 1)) { tailOk = false; break; }
    if (!tailOk) continue;
    const kind: AxisKind = strictLen === count ? 'strict' : strictLen === 1 ? 'dead' : 'plateau';
    if (!relaxed && kind !== 'strict') continue;
    return { count, width, kind, dataAddr, end: dataAddr + count * width, strictLen };
  }
  return undefined;
}

/** Local frame smoothness in 0..1 (1 - mean row+col |Δ| / (range+1); 0.1 flat).
 *  Same composite the pool/family passes use; kept local so structural.ts owns
 *  its scoring. */
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

/** Decode backward pointers to count-prefixed monotone/plateau/dead axes.
 *  The density gate requires a nearby pair; candidate generation may also
 *  inspect scattered pairs, which need separate packing corroboration. */
function decodeHeader(bytes: Uint8Array, off: number, config: ScanConfig, packedAxes = true): { xa: AxisRun; ya: AxisRun } | undefined {
  const { minCols, maxCols, minRows, maxRows } = config.table;
  const { pairSpan, structHeaderAxisMinCount, structAxisMaxCount } = config.pool;
  const xp = r16(bytes, off - 4);
  const yp = r16(bytes, off - 2);
  if (xp === yp || !(xp < off && yp < off)) return undefined;
  if (xp === 0 || yp === 0 || xp === 0xffff || yp === 0xffff) return undefined;
  if (packedAxes && Math.abs(xp - yp) > pairSpan) return undefined;
  const xa = validateAxisAt(bytes, xp, structHeaderAxisMinCount, structAxisMaxCount, true, yp);
  const ya = validateAxisAt(bytes, yp, structHeaderAxisMinCount, structAxisMaxCount, true, xp);
  if (!xa || !ya) return undefined;
  if (xa.count < minCols || xa.count > maxCols || ya.count < minRows || ya.count > maxRows) return undefined;
  return { xa, ya };
}

/** Header-density: count valid backward headers across the whole file. The MS4x
 *  cal-header signature. MEASURED: every synthetic + scrambled 256KB full read
 *  = 0; the two real direct-SA partials = 119 (e36m3) / 125 (s52). */
export function poolStructuralHeaderCount(bytes: Uint8Array, config: ScanConfig): number {
  if (bytes.length >= STRUCT_MAX_BIN_LEN) return 0;
  let n = 0;
  for (let off = 4; off < bytes.length; off++) if (decodeHeader(bytes, off, config)) n++;
  return n;
}

/** Activation: small direct-framed bin AND pool-active AND header-dense. AND-ing
 *  isPoolActive keeps generation consistent with the pool-structural EMISSION
 *  gate in score.ts (which is isPoolActive), so structural is never generated
 *  where it would be silently dropped. */
export function poolStructuralActive(bytes: Uint8Array, prefixed: PrefixedAxis[], config: ScanConfig): boolean {
  if (bytes.length >= STRUCT_MAX_BIN_LEN) return false;
  if (!isPoolActive(prefixed, config)) return false;
  return poolStructuralHeaderCount(bytes, config) >= config.pool.structHeaderGateMin;
}

interface Cand {
  address: number; rows: number; cols: number; format: ValueFormat;
  xAxis: { address: number; count: number; format: ValueFormat };
  yAxis: { address: number; count: number; format: ValueFormat };
  tier: number; score: number;
}

/** Component A — header sweep (tier 0). Packing corroborates scattered
 *  headers and selects the cell width. */
function headerCandidates(bytes: Uint8Array, config: ScanConfig): Cand[] {
  const out: Cand[] = [];
  const headers = new Map<number, NonNullable<ReturnType<typeof decodeHeader>>>();
  for (let off = 4; off < bytes.length; off++) {
    const d = decodeHeader(bytes, off, config, false);
    if (d) headers.set(off, d);
  }
  // Check the expected data end, not the first header-like bytes in the data.
  // An odd byte-table end may carry one C166 word-alignment pad byte.
  const successor = (end: number): number | undefined => {
    for (const off of end % 2 === 1 ? [end + 4, end + 5] : [end + 4]) {
      const header = headers.get(off);
      // Two constant runs can be coincidental pointers inside table data.
      // They supply dimensions, but cannot establish a neighbor's boundary.
      if (header && (header.xa.kind !== 'dead' || header.ya.kind !== 'dead')) return off;
    }
    return undefined;
  };
  const curveAt = (off: number): AxisRun | undefined => {
    if (off > bytes.length - 2) return undefined;
    const ptr = r16(bytes, off);
    if (ptr === 0 || ptr >= off) return undefined;
    const axis = validateAxisAt(bytes, ptr, config.pool.curvePartialMinCount, config.pool.structAxisMaxCount, false);
    return axis && axis.end <= off && off + 2 + axis.count <= bytes.length ? axis : undefined;
  };
  // A pair of consecutive curve descriptors also marks the end of a grid.
  // One pointer alone is too easily forged by ordinary cell values.
  const curveSuccessor = (end: number): boolean => {
    const axis = curveAt(end);
    if (!axis) return false;
    return config.table.widths.some(w => {
      if (w !== 1 && w !== 2) return false;
      const next = end + 2 + axis.count * w;
      return curveAt(next) !== undefined || (next % 2 === 1 && curveAt(next + 1) !== undefined);
    });
  };
  const preceded = new Set<number>();
  for (const [off, d] of headers) for (const w of config.table.widths) {
    if (w !== 1 && w !== 2) continue;
    const next = successor(off + d.xa.count * d.ya.count * w);
    if (next !== undefined) preceded.add(next);
  }
  for (const [off, d] of headers) {
    const cols = d.xa.count;
    const rows = d.ya.count;
    let best: { w: 1 | 2; score: number; exact: boolean } | undefined;
    for (const w of config.table.widths) {
      if (w !== 1 && w !== 2) continue;
      const byteLen = rows * cols * w;
      if (off + byteLen > bytes.length) continue;
      const sc = frameScore(bytes, off, rows, cols, fmtOf(w));
      const exact = successor(off + byteLen) !== undefined || curveSuccessor(off + byteLen);
      // TOTAL order: exact-packing wins; then higher score; then smaller width.
      if (
        best === undefined ||
        (exact && !best.exact) ||
        (exact === best.exact && sc > best.score) ||
        (exact === best.exact && sc === best.score && w < best.w)
      ) {
        best = { w, score: sc, exact };
      }
    }
    if (!best) continue;
    // Curve boundaries choose width only; scattered axes still need a grid neighbor.
    const packed = successor(off + rows * cols * best.w) !== undefined || preceded.has(off);
    const nearby = decodeHeader(bytes, off, config) !== undefined;
    if (!packed && !nearby) continue;
    // A nearby pair followed by small cell values can also decode two bytes
    // late as [old yPtr][unrelated ptr]. Keep the complete nearby pair.
    if (!nearby && off >= 6 && decodeHeader(bytes, off - 2, config)) continue;
    out.push({
      address: off, rows, cols, format: fmtOf(best.w), tier: 0, score: Math.max(0.01, best.score),
      xAxis: { address: d.xa.dataAddr, count: d.xa.count, format: fmtOf(d.xa.width) },
      yAxis: { address: d.ya.dataAddr, count: d.ya.count, format: fmtOf(d.ya.width) },
    });
  }
  return out;
}

interface PlateauAxis { address: number; end: number; count: number; format: ValueFormat; prefixAddr: number; }

/** Whole-file plateau axis scan (file-offset). Sweeps every offset (like
 *  `decodeHeader`'s header sweep — self-validating structural signatures need
 *  no statistical region gate) for count-prefixed runs tolerating a constant
 *  plateau tail (strict prefix >= min(count, structTilePlateauStrictMin));
 *  'dead' runs excluded. Deliberately NOT filtered to classifyRegions 'data'
 *  windows: a tight axis-pair island is only 10-20 bytes wide, so a 256-byte
 *  classification window straddling it stays >= emptyFillMin fill and reads
 *  'empty' even though the pointer itself decodes validly (reproduced: the
 *  planted packed-run fixture's axis pair sits in a region classifyRegions
 *  labels 'empty', which silently dropped it before this fix). */
function plateauAxes(bytes: Uint8Array, config: ScanConfig): PlateauAxis[] {
  const { structHeaderAxisMinCount, structAxisMaxCount, structTilePlateauStrictMin } = config.pool;
  const out: PlateauAxis[] = [];
  for (let ptr = 0; ptr < bytes.length - 2; ptr++) {
    const v = validateAxisAt(bytes, ptr, structHeaderAxisMinCount, structAxisMaxCount, true);
    if (!v || v.kind === 'dead') continue;
    if (v.strictLen < Math.min(v.count, structTilePlateauStrictMin)) continue;
    out.push({ address: v.dataAddr, end: v.end, count: v.count, format: fmtOf(v.width), prefixAddr: ptr });
  }
  // TOTAL order for deterministic pair enumeration.
  out.sort((a, b) => a.address - b.address || a.count - b.count || a.format.width - b.format.width);
  return out;
}

/** Leading row's boundary contrast divided by the table's internal row
 *  variation. A passing ratio alone can include neighboring bytes; its
 *  local peak supplies the start used by the packed run. */
function leadingEdge(bytes: Uint8Array, off: number, rows: number, cols: number, fmt: ValueFormat): number {
  const w = fmt.width;
  const prevRowAddr = off - cols * w;
  if (prevRowAddr < 0) return Infinity;
  const boundary = colTvAt(bytes, prevRowAddr, 2, cols, fmt);
  if (boundary === undefined) return Infinity;
  const internal = colTvAt(bytes, off, rows, cols, fmt);
  if (internal === undefined) return 0;
  // 1e-9: structural divide-by-zero guard (same role as startEdgeOk's).
  return boundary / (internal + 1e-9);
}

/** Component C — packed tiling from an adjacency-tight chained plateau pair (the
 *  stock [axisChain][table] law: one axis ends exactly at the other's count
 *  prefix). Locate the first smooth RxC block after the pair in a bounded
 *  window, refining its start to the strongest edge within one widest row,
 *  then step by byte-length placing consecutive blocks while smooth; emit the
 *  run only if it is at least structTileMinRun long. Restricting to tight
 *  pairs is what keeps this from a combinatorial spurious-run explosion
 *  (measured). */
function tileCandidates(bytes: Uint8Array, config: ScanConfig): Cand[] {
  const { minCols, maxCols, minRows, maxRows } = config.table;
  const { structTileFrameMin, structTileMinRun, structTileWindow, edgeMin } = config.pool;
  const axes = plateauAxes(bytes, config);
  const out: Cand[] = [];
  const bestW = (off: number, rows: number, cols: number): { w: 1 | 2; sc: number } | undefined => {
    let best: { w: 1 | 2; sc: number } | undefined;
    for (const w of [1, 2] as const) {
      if (off + rows * cols * w > bytes.length) continue;
      const sc = frameScore(bytes, off, rows, cols, fmtOf(w));
      // TOTAL order: higher score, then smaller width.
      if (best === undefined || sc > best.sc || (sc === best.sc && w < best.w)) best = { w, sc };
    }
    return best;
  };
  for (const x of axes) {
    for (const y of axes) {
      if (x.address === y.address) continue;
      // adjacency-tight chain: one axis ends exactly at the other's prefix byte.
      if (y.end !== x.prefixAddr && x.end !== y.prefixAddr) continue;
      // Equal counts give both axis orders identical grids and scores. Use
      // the packed [rowAxis][colAxis] layout, as in poolAdjacentTables.
      if (x.count === y.count && x.end === y.prefixAddr) continue;
      const cols = x.count;
      const rows = y.count;
      if (cols < minCols || cols > maxCols || rows < minRows || rows > maxRows) continue;
      const start0 = Math.max(x.end, y.end);
      let first = -1;
      let firstWidth: 1 | 2 = 1;
      let bestEdge = -Infinity;
      let searchEnd = Math.min(start0 + structTileWindow, bytes.length - rows * cols);
      for (let off = start0; off <= searchEnd; off++) {
        for (const w of [1, 2] as const) {
          if (frameScore(bytes, off, rows, cols, fmtOf(w)) < structTileFrameMin) continue;
          const edge = leadingEdge(bytes, off, rows, cols, fmtOf(w));
          if (edge < edgeMin) continue;
          // The first passing window can still include part of the preceding
          // row. Refine locally so a later, unrelated table cannot win.
          if (first < 0) searchEnd = Math.min(searchEnd, off + cols * 2);
          if (edge > bestEdge) { first = off; firstWidth = w; bestEdge = edge; }
        }
      }
      if (first < 0) continue;
      const run: Cand[] = [];
      let off = first;
      for (let step = 0; step < STRUCT_TILE_MAX_STEPS && off + rows * cols <= bytes.length; step++) {
        const b = step === 0 ? { w: firstWidth, sc: frameScore(bytes, off, rows, cols, fmtOf(firstWidth)) } : bestW(off, rows, cols);
        if (!b || b.sc < structTileFrameMin) break;
        run.push({
          address: off, rows, cols, format: fmtOf(b.w), tier: 2, score: Math.max(0.01, b.sc),
          xAxis: { address: x.address, count: x.count, format: x.format },
          yAxis: { address: y.address, count: y.count, format: y.format },
        });
        off += rows * cols * b.w;
      }
      if (run.length >= structTileMinRun) for (const c of run) out.push(c);
    }
  }
  return out;
}

/** Internal conflict resolution then map to PoolStructTable[]. Sort key is a
 *  TOTAL order: tier asc, score desc, address asc, rows asc, cols asc, width asc.
 *  Greedy exclusive tiling (any byte overlap with a kept candidate = drop). */
function resolve(cands: Cand[]): PoolStructTable[] {
  const sorted = [...cands].sort(
    (a, b) =>
      a.tier - b.tier ||
      b.score - a.score ||
      a.address - b.address ||
      a.rows - b.rows ||
      a.cols - b.cols ||
      a.format.width - b.format.width
  );
  const kept: Cand[] = [];
  const span = (c: Cand): [number, number] => [c.address, c.address + c.rows * c.cols * c.format.width];
  const overlaps = (a: [number, number], b: [number, number]): boolean => Math.min(a[1], b[1]) > Math.max(a[0], b[0]);
  for (const c of sorted) {
    const s = span(c);
    if (kept.some((k) => overlaps(span(k), s))) continue;
    kept.push(c);
  }
  return kept.map((c) => ({
    address: c.address, rows: c.rows, cols: c.cols, format: c.format,
    xAxis: { address: c.xAxis.address, count: c.xAxis.count, format: c.xAxis.format, end: c.xAxis.address + c.xAxis.count * c.xAxis.format.width, maximal: true },
    yAxis: { address: c.yAxis.address, count: c.yAxis.count, format: c.yAxis.format, end: c.yAxis.address + c.yAxis.count * c.yAxis.format.width, maximal: true },
  }));
}

/** Detect structural tables. Caller must ensure poolStructuralActive first (this
 *  re-checks the size ceiling + gate defensively so the exported function is
 *  safe to call directly). A caller that has ALREADY computed the activation
 *  gate may pass it as `active` to skip the defensive re-sweep (the gate's
 *  header-density count is a whole-file scan — scan() computes it once and
 *  shares it with the Phase-3 partial-curve gate). Unions Component A (header
 *  sweep, tier 0) and Component C (adjacency-tight packed tiling, tier 2);
 *  `resolve` arbitrates any overlap with a deterministic total order. */
export function poolStructuralTables(bytes: Uint8Array, prefixed: PrefixedAxis[], config: ScanConfig, active?: boolean): PoolStructTable[] {
  if (!(active ?? poolStructuralActive(bytes, prefixed, config))) return [];
  const cands: Cand[] = [...headerCandidates(bytes, config), ...tileCandidates(bytes, config)];
  return resolve(cands);
}
