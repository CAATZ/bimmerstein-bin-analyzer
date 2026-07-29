import { createBinImage } from '@binanalyzer/core';
import type { MapDef, ValueFormat } from '@binanalyzer/core';
import { saToFo } from '@binanalyzer/engine';
import type { GroundTruth } from './groundtruth.js';

/**
 * Synthetic fixture generator (spec §5): builds a bin with planted smooth
 * maps + monotone axes + code-like high-entropy filler + fill regions, and
 * returns the matching ground truth. MUST be seeded-deterministic (no
 * Math.random without seed param) so committed fixtures are reproducible.
 * Implemented in plan Phase 4 (TDD).
 */
export interface SyntheticSpec {
  seed: number;
  sizeBytes: number;
  mapCount: number;
}

const U16BE: ValueFormat = { width: 2, signed: false, endianness: 'big' };

/** mulberry32 — tiny seeded PRNG, returns [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSynthetic(spec: SyntheticSpec): { bytes: Uint8Array; truth: GroundTruth } {
  const rng = mulberry32(spec.seed);
  const randInt = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const bytes = new Uint8Array(spec.sizeBytes);
  bytes.fill(0xff);
  const putU16 = (off: number, v: number) => {
    const clamped = Math.max(0, Math.min(0xffff, Math.round(v)));
    bytes[off] = clamped >> 8;
    bytes[off + 1] = clamped & 0xff;
  };
  // code-like filler after 4KB header
  const codeEnd = 4096 + Math.floor(spec.sizeBytes * 0.3);
  for (let i = 4096; i < codeEnd; i++) bytes[i] = Math.floor(rng() * 256);

  const maps: MapDef[] = [];
  let cursor = codeEnd + 256;
  for (let k = 0; k < spec.mapCount; k++) {
    const cols = randInt(6, 16);
    const rows = randInt(4, 12);
    const xAddr = cursor;
    const xStart = randInt(400, 1200);
    const xStep = randInt(80, 400);
    for (let i = 0; i < cols; i++) putU16(xAddr + 2 * i, xStart + i * xStep);
    const yAddr = xAddr + 2 * cols;
    const yStart = randInt(500, 1500);
    const yStep = randInt(100, 700);
    for (let i = 0; i < rows; i++) putU16(yAddr + 2 * i, yStart + i * yStep);
    const mapAddr = yAddr + 2 * rows;
    const base = randInt(1500, 9000);
    const rStep = randInt(20, 120);
    const cStep = randInt(10, 60);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        putU16(mapAddr + 2 * (r * cols + c), base + r * rStep + c * cStep + randInt(0, 6));
      }
    }
    maps.push({
      id: `gt-${spec.seed}-${k}`,
      name: `Planted ${rows}x${cols} #${k}`,
      address: mapAddr, rows, cols, format: U16BE,
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major',
      xAxis: { kind: 'referenced', count: cols, address: xAddr, format: U16BE },
      yAxis: { kind: 'referenced', count: rows, address: yAddr, format: U16BE },
      provenance: 'imported',
    });
    cursor = mapAddr + 2 * rows * cols + randInt(16, 64);
    if (cursor + 2048 > spec.sizeBytes) throw new Error('sizeBytes too small for mapCount');
  }
  return {
    bytes,
    truth: { fixture: `synth-${spec.seed}`, binSha256: createBinImage(bytes, 'synth').sha256, maps },
  };
}

const U8: ValueFormat = { width: 1, signed: false, endianness: 'big' };
const U16LE: ValueFormat = { width: 2, signed: false, endianness: 'little' };

export interface PoolSyntheticSpec {
  seed: number;
  sizeBytes: number;
  groupCount: number;
}

/**
 * Shared-axis-pool fixture family (spec §5, addendum 2) — plants the measured
 * MS41-family layout: groups of [count-prefixed axis pool (u8-prefixed axes
 * first, then u16-LE — the ordering keeps every axis's follower
 * trend-breaking)] + [zero-padded scalar-block filler] + [tables referencing
 * pool axes at a distance]; every third group is a packed quantized cluster
 * with high-contrast stride separators (the real knock-cluster pattern).
 * Deterministic via the same mulberry32 PRNG.
 */
export function generatePoolSynthetic(spec: PoolSyntheticSpec): { bytes: Uint8Array; truth: GroundTruth } {
  const rng = mulberry32(spec.seed);
  const randInt = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const bytes = new Uint8Array(spec.sizeBytes);
  bytes.fill(0xff);
  const codeEnd = 4096 + Math.floor(spec.sizeBytes * 0.3);
  for (let i = 4096; i < codeEnd; i++) bytes[i] = Math.floor(rng() * 256);

  const writeU16le = (off: number, v: number): void => {
    bytes[off] = v & 0xff;
    bytes[off + 1] = (v >> 8) & 0xff;
  };
  // scalar-block filler: a `2` then zero padding (high-contrast, trend-breaking
  // boundary), then constant blocks with jumps between them — mimics the
  // scalars/config bytes packed between real cal structures. Constant blocks
  // self-reject as tables (range 0) and break monotone runs.
  const writeFiller = (off: number, len: number): void => {
    let i = 0;
    if (len >= 2) {
      bytes[off] = 2;
      const zeros = Math.min(len - 1, randInt(5, 9));
      for (let k = 1; k <= zeros; k++) bytes[off + k] = 0;
      i = 1 + zeros;
    }
    while (i < len) {
      const blockLen = Math.min(len - i, randInt(6, 24));
      const v = randInt(0, 255);
      for (let k = 0; k < blockLen; k++) bytes[off + i + k] = v;
      i += blockLen;
    }
  };

  interface PoolAxisPlanted { address: number; count: number; format: ValueFormat }
  const maps: MapDef[] = [];
  let cursor = codeEnd + 256;

  for (let g = 0; g < spec.groupCount; g++) {
    const isCluster = g % 3 === 2;
    const axisCount = isCluster ? 2 : randInt(3, 6);
    const u16Count = isCluster ? 0 : Math.min(axisCount - 1, Math.floor(axisCount * 0.35 * (0.5 + rng())));
    const axes: PoolAxisPlanted[] = [];
    for (let k = 0; k < axisCount; k++) {
      const u16 = k >= axisCount - u16Count; // u8 axes first, then u16 (see doc comment)
      const count = randInt(4, isCluster ? 16 : 12);
      if (u16) {
        writeU16le(cursor, count);
        const addr = cursor + 2;
        let v = randInt(400, 900);
        for (let i = 0; i < count; i++) {
          writeU16le(addr + 2 * i, v);
          v += randInt(80, 400);
        }
        axes.push({ address: addr, count, format: U16LE });
        cursor = addr + 2 * count;
      } else {
        bytes[cursor] = count;
        const addr = cursor + 1;
        let v = randInt(24, 60); // starts above axis.maxCount so count prefixes break runs
        const maxStep = Math.floor((250 - v) / count);
        for (let i = 0; i < count; i++) {
          bytes[addr + i] = v;
          v += randInt(1, Math.max(1, Math.min(9, maxStep)));
        }
        axes.push({ address: addr, count, format: U8 });
        cursor = addr + count;
      }
    }
    // pool terminator: breaks monotone continuation in u8 AND u16 reads
    bytes[cursor] = 2;
    bytes[cursor + 1] = 0;
    cursor += 2;
    const gap = randInt(40, 400);
    writeFiller(cursor, gap);
    cursor += gap;

    const tableCount = isCluster ? randInt(3, 5) : randInt(2, 4);
    for (let t = 0; t < tableCount; t++) {
      let xa: PoolAxisPlanted;
      let ya: PoolAxisPlanted;
      if (isCluster) {
        xa = axes[0]!;
        ya = axes[1]!;
      } else {
        const xi = randInt(0, axes.length - 1);
        let yi = randInt(0, axes.length - 1);
        if (yi === xi) yi = (yi + 1) % axes.length;
        xa = axes[xi]!;
        ya = axes[yi]!;
      }
      const cols = xa.count;
      const rows = ya.count;
      const w1 = isCluster || rng() < 0.5;
      const addr = cursor;
      if (w1) {
        // quantized byte table; real MS41 byte maps ramp gently (1–4 counts/row)
        const base = isCluster ? 1 : randInt(30, 140);
        const rStep = isCluster ? 1 : randInt(1, 4);
        const cStep = isCluster ? 0 : randInt(1, 3);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const bump = isCluster ? (r < rows / 2 ? r : rows - 1 - r) : r * rStep + c * cStep;
            bytes[addr + r * cols + c] = Math.min(250, base + Math.floor(bump) + (isCluster ? 0 : randInt(0, 1)));
          }
        }
        cursor = addr + rows * cols;
      } else {
        const base = randInt(1500, 9000);
        const rStep = randInt(20, 120);
        const cStep = randInt(10, 60);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            writeU16le(addr + 2 * (r * cols + c), base + r * rStep + c * cStep + randInt(0, 6));
          }
        }
        cursor = addr + 2 * rows * cols;
      }
      maps.push({
        id: `gtp-${spec.seed}-${g}-${t}`,
        name: `Pool ${rows}x${cols} g${g}t${t}`,
        address: addr,
        rows,
        cols,
        format: w1 ? U8 : U16LE,
        scaling: { factor: 1, offset: 0, units: '', digits: 0 },
        orientation: 'row-major',
        xAxis: { kind: 'referenced', count: cols, address: xa.address, format: xa.format },
        yAxis: { kind: 'referenced', count: rows, address: ya.address, format: ya.format },
        provenance: 'imported',
      });
      if (isCluster) {
        // high-contrast stride separator (the real knock cluster's 135,35,90,35)
        const sep = randInt(2, 4);
        for (let k = 0; k < sep; k++) bytes[cursor + k] = randInt(120, 230);
        cursor += sep;
      } else {
        const between = randInt(16, 64);
        writeFiller(cursor, between);
        cursor += between;
      }
    }
    const groupGap = randInt(200, 600);
    writeFiller(cursor, groupGap);
    cursor += groupGap;
    if (cursor + 4096 > spec.sizeBytes) throw new Error('sizeBytes too small for groupCount');
  }
  return {
    bytes,
    truth: {
      fixture: `synth-pool-${spec.seed}`,
      binSha256: createBinImage(bytes, 'synth-pool').sha256,
      maps,
    },
  };
}

export interface PartialSyntheticSpec {
  seed: number;
  sizeBytes: number;
  tableCount: number;
  /**
   * Phase-3 partial-curve plants (the synth-pcurve fixture family; spike
   * docs/notes/ms41-p3-partial-curves-spike.md). Off by default — when absent
   * the generator's LCG draws and byte writes are IDENTICAL to the
   * pre-Phase-3 generator, so seeds 201-204 stay byte-pinned (see the
   * seed-201 regression test in synthetic.test.ts). When set, `plants` curve
   * layouts are written strictly AFTER the base grid/axis skeleton (both LCG
   * draws and byte writes), cycling the three anchor classes the tiling
   * discriminator accepts: pool-abut ([n][axis][hdr][data] whose block starts
   * at the axis-pool span end — also adjax-contiguous), a pad-chain PAIR (an
   * odd-length w1 block linking at end+1 — the C166 word-alignment pad — to a
   * second block, the component anchored at the leading axis), and a bare
   * adjax self-anchor on a count-3 axis (below the pool scanner's minCount,
   * so NO trusted span exists — contiguity is the only anchor). The returned
   * truth is then the planted CURVES ONLY (rows=n, cols=1, w1, referenced
   * yAxis) under fixture `synth-pcurve-<seed>` — the PARTIAL_CURVE_GATE
   * measures the curve channel exactly.
   */
  curvePlants?: { plants: number };
}

/**
 * Deterministic direct-SA cal-partial generator (spec §5). Plants the MS4x
 * header-cal-layout that the partial-structural detector activates on: PACKED
 * chained axis pairs [xPfx][xCells][yPfx][yCells] followed by header'd tables
 * ([xPtr u16LE][yPtr u16LE] + smooth data), tables packed tight so the generic
 * byte scanner MISFRAMES them (weak baseline) while the header recovers exact
 * dims (structural lift). Cells are noise elsewhere. NO randomness (seeded LCG,
 * mirrors generatePoolSynthetic's determinism contract).
 */
export function generatePartialSynthetic(spec: PartialSyntheticSpec): { bytes: Uint8Array; truth: GroundTruth } {
  let s = (spec.seed * 2654435761) >>> 0;
  const rng = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const N = spec.sizeBytes;
  const b = new Uint8Array(N);
  for (let i = 0; i < N; i++) b[i] = Math.floor(rng() * 256);
  const w16 = (o: number, v: number): void => {
    b[o] = v & 0xff;
    b[o + 1] = (v >> 8) & 0xff;
  };
  const maps: MapDef[] = [];
  const dims: Array<[number, number]> = [
    [8, 6],
    [6, 5],
    [10, 8],
    [5, 5],
    [12, 4],
    [7, 9],
    [4, 7],
    [9, 6],
  ];
  let ax = 0x100;
  let tp = 0x1804;
  for (let k = 0; k < spec.tableCount && ax < 0x1000 && tp + 0x100 < N; k++) {
    const [cols, rows] = dims[k % dims.length]!;
    const xPfx = ax;
    b[xPfx] = cols;
    const xData = xPfx + 1;
    let vx = 8 + Math.floor(rng() * 20);
    for (let i = 0; i < cols; i++) {
      b[xData + i] = Math.min(250, vx);
      vx += 1 + Math.floor(rng() * 5);
    }
    const yPfx = xData + cols;
    b[yPfx] = rows;
    const yData = yPfx + 1;
    let vy = 8 + Math.floor(rng() * 20);
    for (let i = 0; i < rows; i++) {
      b[yData + i] = Math.min(250, vy);
      vy += 1 + Math.floor(rng() * 5);
    }
    ax = yData + rows + 2;
    w16(tp - 4, xPfx);
    w16(tp - 2, yPfx);
    const base = 40 + Math.floor(rng() * 40);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) b[tp + r * cols + c] = Math.max(0, Math.min(255, base + r * 2 + c * 3 + Math.floor(rng() * 4)));
    maps.push({
      id: `synthp-${spec.seed}-0x${tp.toString(16)}`,
      name: `Synthetic Partial 0x${tp.toString(16)}`,
      address: tp,
      rows,
      cols,
      format: { width: 1, signed: false, endianness: 'big' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major',
      provenance: 'imported',
      xAxis: { kind: 'referenced', address: xData, count: cols, format: { width: 1, signed: false, endianness: 'big' } },
      yAxis: { kind: 'referenced', address: yData, count: rows, format: { width: 1, signed: false, endianness: 'big' } },
    });
    tp += rows * cols + 4;
  }
  // Phase-3 curve plants — strictly after the base loop (draws AND writes),
  // so a spec without the knob never reaches this code (byte-pin discipline).
  if (spec.curvePlants) {
    const U8 = { width: 1, signed: false, endianness: 'big' } as const;
    const curveMaps: MapDef[] = [];
    const pushCurve = (p: number, n: number, axData: number): void => {
      curveMaps.push({
        id: `synthpc-${spec.seed}-0x${p.toString(16)}`,
        name: `Synthetic Partial Curve 0x${p.toString(16)}`,
        address: p, rows: n, cols: 1, format: U8,
        scaling: { factor: 1, offset: 0, units: '', digits: 0 },
        orientation: 'row-major',
        provenance: 'imported',
        yAxis: { kind: 'referenced', address: axData, count: n, format: U8 },
      });
    };
    // Uint8Array OOB writes are silent no-ops — an unguarded plant cursor
    // past sizeBytes would yield truncated plants whose ground truth points
    // at bytes that were never written. Guarding the two write helpers
    // covers every byte the plant loop writes.
    const guard = (end: number): void => {
      if (end > N) throw new Error('sizeBytes too small for curvePlants');
    };
    // [n][n strictly-ascending u8 cells]; bounded so the ascent never clips
    const putAxis = (prefix: number, n: number): number => {
      guard(prefix + 1 + n);
      b[prefix] = n;
      let v = 5 + Math.floor(rng() * 20);
      for (let i = 0; i < n; i++) {
        b[prefix + 1 + i] = v;
        v += 1 + Math.floor(rng() * 6);
      }
      return prefix + 1;
    };
    // [ptr u16LE][n data bytes] — returns p (the data start / curve address)
    const putBlock = (s: number, ptr: number, n: number): number => {
      guard(s + 2 + n);
      w16(s, ptr);
      for (let i = 0; i < n; i++) b[s + 2 + i] = Math.floor(rng() * 256);
      return s + 2;
    };
    let c = 0x2800; // fixed plant base, beyond the packed table region
    for (let i = 0; i < spec.curvePlants.plants; i++) {
      if (c % 2 === 1) c += 1; // word-align each plant (the pad case's parity relies on it)
      if (i % 3 === 0) {
        // pool-abut + adjax: [n][axis][hdr][data] — block starts at the axis
        // span end (trusted edge when the axis scans maximal) AND is
        // adjax-contiguous (anchor holds regardless).
        const n = 6 + Math.floor(rng() * 4); // 6..9 (>= axis.minCount)
        const axData = putAxis(c, n);
        const p = putBlock(c + 1 + n, c, n);
        pushCurve(p, n, axData);
        c = p + n + 8 + Math.floor(rng() * 8);
      } else if (i % 3 === 1) {
        // pad-chain pair: [P_B axis][P_A axis][blockA(adjax on P_A)][1 pad][blockB(ptr->P_B)].
        // c even + nB=5 makes blockA's end ODD, so the component closure must
        // take the end+1 pad link to reach blockB — the C166 pad case.
        const nA = 5 + 2 * Math.floor(rng() * 2); // 5 or 7 (odd)
        const nB = 5;
        const aB = putAxis(c, nB);
        const aA = putAxis(c + 1 + nB, nA);
        const sA = c + 2 + nB + nA; // = P_A end (edge + adjax anchor)
        const pA = putBlock(sA, c + 1 + nB, nA);
        const aEnd = sA + 2 + nA; // odd by construction
        const pB = putBlock(aEnd + 1, c, nB);
        pushCurve(pA, nA, aA);
        pushCurve(pB, nB, aB);
        c = pB + nB + 8 + Math.floor(rng() * 8);
      } else {
        // bare adjax: count-3 axis is below the pool scanner's minCount, so
        // NO trusted span exists — [n][axis][hdr][data] contiguity is the
        // only anchor (the discriminator's F-adjax component).
        const n = 3;
        const axData = putAxis(c, n);
        const p = putBlock(c + 1 + n, c, n);
        pushCurve(p, n, axData);
        c = p + n + 8 + Math.floor(rng() * 8);
      }
    }
    return {
      bytes: b,
      truth: { fixture: `synth-pcurve-${spec.seed}`, binSha256: createBinImage(b, 'synth-pcurve').sha256, maps: curveMaps },
    };
  }
  return {
    bytes: b,
    truth: { fixture: `synth-partial-${spec.seed}`, binSha256: createBinImage(b, 'synth-partial').sha256, maps },
  };
}

export interface CurveSyntheticSpec {
  seed: number;
  sizeBytes: number;
  /** Number of 1D curves planted (also, since each gets exactly one call
   *  site, the curve-reader-arg count the family gate counts against
   *  config.family.ms41.curveActivateMin). */
  curveCount: number;
  /**
   * Optional fallback-class plants (Phase 1.1 spike, docs/notes/
   * ms41-p11-custom-curves-spike.md): out-of-sample CI coverage for
   * detectMs41CurveFallbacks' tier-5 (backward header below the tier-0 floor)
   * and tier-6 (forward/reversed axis adjacency) paths — see curves.ts.
   * Defaults to none. When absent, generateCurveSynthetic's byte output is
   * IDENTICAL to the pre-Phase-1.1 generator: the fallback block below runs
   * strictly AFTER the existing curveCount loop (both its LCG draws and its
   * byte writes), so a spec without this field never reaches the new code —
   * seeds 301/302/303/304 stay byte-for-byte pinned (see the seed-301
   * regression test in synthetic.test.ts).
   */
  fallbackPlants?: {
    /** Count-2/3 backward-header curves: below curveAxisMinCount (4, tier-0's
     *  floor) but at/above curveEmitMinCount (2, tier-5's floor). */
    headerLow: number;
    /** Forward axis-adjacency curves `[prefix][axis][data]` (tier 6), axis
     *  run ending exactly at the data SA. Alternates u8/u16 prefix width. */
    fwdAdj: number;
    /** Reversed axis-adjacency curves `[data][prefix][axis]` (tier 6). */
    revAdj: number;
  };
}

/**
 * MS41 1D-curve fixture family (spec 2026-07-15 Phase 1, Task 6 plan). Builds
 * a full-read-SHAPED bin that clears BOTH gates in packages/engine/src/family/ms41/analyzer.ts:
 *  1. the family activation gate — bytes.length >= MS41_MIN_BIN_LEN, >=
 *     movImmCalMin MOV-r12-cal-immediate call sites, >= minReaders
 *     self-located GRID readers — via a shared-axis 4x6 header'd table
 *     cluster read by two byte readers (the exact idiom
 *     packages/engine/test/family-analyzer.test.ts's buildActiveImage()
 *     proves activates the gate; replicated here byte-for-byte, LCG-seeded
 *     values instead of fixed ones);
 *  2. the curve activation floor — >= curveActivateMin curve-reader CALL
 *     SITES (buildActiveImage's addCurveReader() idiom, extended to N
 *     distinct curves and two curve-reader targets: cpu 0x1400 fetches
 *     bytes (w1), cpu 0x1600 fetches LE words (w2), alternating per curve so
 *     both reader variants get exercised end-to-end).
 * Each planted curve is a 2-byte backward `[axisPtr u16LE]` header at
 * (dataSA - 2) pointing to a count-prefixed strictly-monotone u8 axis run,
 * followed by the curve's own data (count * w bytes) at dataSA. All
 * structural addresses (grid axes/tables, curve reader targets, region
 * bases) are FIXED across seeds — only cell VALUES, axis counts, and gaps
 * are LCG-derived (same discipline as generatePoolSynthetic/
 * generatePartialSynthetic's fixed skeleton + seeded values). Deterministic
 * LCG (mirrors generatePartialSynthetic's PRNG); NO Math.random/Date.
 * Ground truth mirrors the engine's curve emission exactly: N×1
 * (rows=count, cols=1) + a single referenced yAxis, addresses in FILE space
 * via the real engine's saToFo (imported, not reimplemented, so the fixture
 * can never drift from the frame law it is testing).
 */
export function generateCurveSynthetic(spec: CurveSyntheticSpec): { bytes: Uint8Array; truth: GroundTruth } {
  let s = (spec.seed * 2654435761) >>> 0;
  const rng = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const randInt = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

  const bytes = new Uint8Array(spec.sizeBytes); // zero-filled: 0x00 decodes as an
  // inert 2-byte C166 instruction in the sweep AND as an always-invalid axis
  // pointer (ptr=0 < MS41_CAL_SA_MIN) everywhere we do not deliberately write —
  // exactly the invariant buildActiveImage/addCurveReader rely on.

  const putSA = (sa: number, vals: readonly number[]): void => {
    const fo0 = saToFo(sa);
    for (let i = 0; i < vals.length; i++) bytes[fo0 + i] = vals[i]!;
  };
  /** MOV r12,#sa (E6 FC lo hi); CALLS seg=0,#targetCpu (DA 00 lo hi) — 8 bytes, r12dist 0. */
  const writeCallSite = (fo0: number, sa: number, targetCpu: number): void => {
    bytes[fo0] = 0xe6;
    bytes[fo0 + 1] = 0xfc;
    bytes[fo0 + 2] = sa & 0xff;
    bytes[fo0 + 3] = (sa >> 8) & 0xff;
    bytes[fo0 + 4] = 0xda;
    bytes[fo0 + 5] = 0x00;
    bytes[fo0 + 6] = targetCpu & 0xff;
    bytes[fo0 + 7] = (targetCpu >> 8) & 0xff;
  };

  // --- Grid-reader activation scaffold: a shared 6-wide/4-tall u8 axis pair
  // and six 4x6 header'd tables, read by two self-locating byte readers
  // (buildActiveImage's proven idiom — see analyzer.ts's ms41Analyzer gate). ---
  const GRID_X_SA = 0x100;
  const GRID_Y_SA = 0x200;
  const gridXVals = [6];
  let gx = randInt(8, 30);
  for (let i = 0; i < 6; i++) {
    gridXVals.push(gx);
    gx += randInt(4, 20);
  }
  putSA(GRID_X_SA, gridXVals);
  const gridYVals = [4];
  let gy = randInt(8, 30);
  for (let i = 0; i < 4; i++) {
    gridYVals.push(gy);
    gy += randInt(4, 20);
  }
  putSA(GRID_Y_SA, gridYVals);

  const GRID_SAS = [0x300, 0x340, 0x380, 0x3c0, 0x400, 0x440];
  for (const sa of GRID_SAS) {
    putSA(sa - 4, [GRID_X_SA & 0xff, (GRID_X_SA >> 8) & 0xff, GRID_Y_SA & 0xff, (GRID_Y_SA >> 8) & 0xff]);
    const data: number[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) data.push(randInt(20, 230));
    putSA(sa, data);
  }
  const GRID_A_CPU = 0x1000;
  const GRID_B_CPU = 0x1200;
  bytes.set([0xa9, 0x24], GRID_A_CPU); // FETCH_BYTE reader body
  bytes.set([0xa9, 0x24], GRID_B_CPU); // FETCH_BYTE reader body

  let o = 0x40;
  for (let i = 0; i < 190; i++) {
    writeCallSite(o, GRID_SAS[i % 6]!, GRID_A_CPU);
    o += 8;
  }
  for (let i = 0; i < 10; i++) {
    writeCallSite(o, GRID_SAS[i % 6]!, GRID_B_CPU);
    o += 8;
  }
  // ^ 200 grid call sites: both targets clear readerMinArgs (6 distinct args
  // each) and readerHeaderRateMin (100% header-backed); minReaders (2) clears.

  // --- Curve scaffold: two curve-reader targets, distinct from the grid
  // readers above, each with its own fetch-width body. Curve dataSA's sa-4
  // bytes are left untouched (zero) so neither target passes the GRID
  // reader's 4-byte header test — addCurveReader's exclusion idiom. ---
  const CURVE_A_CPU = 0x1400; // w1 (byte) reader
  const CURVE_B_CPU = 0x1600; // w2 (LE word) reader
  bytes.set([0xa9, 0x24], CURVE_A_CPU); // FETCH_BYTE
  bytes.set([0xa8, 0x24], CURVE_B_CPU); // FETCH_WORD

  const U8fmt: ValueFormat = { width: 1, signed: false, endianness: 'big' };
  const U16LEfmt: ValueFormat = { width: 2, signed: false, endianness: 'little' };
  const maps: MapDef[] = [];
  let cursor = 0x800; // clear of the grid scaffold (highest grid use ~0x440+24 = 0x458)
  for (let k = 0; k < spec.curveCount; k++) {
    const w: 1 | 2 = k % 2 === 0 ? 1 : 2;
    const targetCpu = w === 1 ? CURVE_A_CPU : CURVE_B_CPU;
    const count = randInt(4, 10);
    const axisPtr = cursor;
    const axisVals = [count];
    let av = randInt(4, 40);
    for (let i = 0; i < count; i++) {
      axisVals.push(av);
      av += randInt(1, 12); // strictly increasing; worst case 40+10*12=160, well clear of 0xFF
    }
    putSA(axisPtr, axisVals);
    cursor = axisPtr + 1 + count;
    const gap1 = randInt(2, 6); // >=2: sa-4 for the eventual dataSA lands in this untouched gap
    const headerPos = cursor + gap1;
    const dataSA = headerPos + 2; // sa; sa-2 === headerPos by construction
    putSA(headerPos, [axisPtr & 0xff, (axisPtr >> 8) & 0xff]);
    const curveVals: number[] = [];
    for (let i = 0; i < count * w; i++) curveVals.push(randInt(0, 255));
    putSA(dataSA, curveVals);
    cursor = dataSA + count * w + randInt(2, 6);

    writeCallSite(o, dataSA, targetCpu);
    o += 8;

    maps.push({
      id: `synthc-${spec.seed}-0x${dataSA.toString(16)}`,
      name: `Synthetic Curve 0x${dataSA.toString(16)}`,
      address: saToFo(dataSA),
      rows: count,
      cols: 1,
      format: w === 1 ? U8fmt : U16LEfmt,
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major',
      provenance: 'imported',
      yAxis: { kind: 'referenced', address: saToFo(axisPtr + 1), count, format: U8fmt },
    });
  }

  // --- Fallback-class plants (Phase 1.1, optional — see the field's JSDoc
  // for the byte-identity contract when absent). Everything below runs ONLY
  // when spec.fallbackPlants is set, strictly after the loop above, so the
  // pre-Phase-1.1 LCG stream and bytes are untouched when it is not. ---
  if (spec.fallbackPlants) {
    const { headerLow, fwdAdj, revAdj } = spec.fallbackPlants;
    // tier-6 adjacency probes up to axis.maxCount (64) cells at width <=2 in
    // EITHER direction from a curve-reader arg SA (worst case ~130 bytes), so
    // a 300-500 byte zero gap between plants guarantees one plant's
    // adjacency search never reads into a NEIGHBOR's planted bytes — only
    // into genuine zero filler, which always self-rejects (count 0 <
    // curveEmitMinCount). Also separates the fallback block from the
    // curveCount loop's own tail.
    const isolate = (): void => {
      cursor += randInt(300, 500);
    };
    let wToggle = 0; // shared across all three classes: keeps the two curve
    // readers' distinct-arg counts (and so curveReaderHeaderRateMin) balanced.
    isolate();

    // headerLow (tier 5): EXACT same backward-header shape as the curveCount
    // loop above, just with count restricted to {2,3} — below curveAxisMinCount
    // (4, the tier-0 floor) but at/above curveEmitMinCount (2, tier-5's).
    for (let k = 0; k < headerLow; k++) {
      const w: 1 | 2 = wToggle++ % 2 === 0 ? 1 : 2;
      const targetCpu = w === 1 ? CURVE_A_CPU : CURVE_B_CPU;
      const count = 2 + (k % 2); // alternates 2, 3 — both represented
      const axisPtr = cursor;
      const axisVals = [count];
      let av = randInt(4, 40);
      for (let i = 0; i < count; i++) {
        axisVals.push(av);
        av += randInt(1, 12);
      }
      putSA(axisPtr, axisVals);
      cursor = axisPtr + 1 + count;
      const gap1 = randInt(2, 6);
      const headerPos = cursor + gap1;
      const dataSA = headerPos + 2;
      putSA(headerPos, [axisPtr & 0xff, (axisPtr >> 8) & 0xff]);
      const curveVals: number[] = [];
      for (let i = 0; i < count * w; i++) curveVals.push(randInt(0, 255));
      putSA(dataSA, curveVals);
      cursor = dataSA + count * w;

      writeCallSite(o, dataSA, targetCpu);
      o += 8;

      maps.push({
        id: `synthc-fb-${spec.seed}-headerLow-0x${dataSA.toString(16)}`,
        name: `Synthetic Fallback Header-Low Curve 0x${dataSA.toString(16)}`,
        address: saToFo(dataSA),
        rows: count,
        cols: 1,
        format: w === 1 ? U8fmt : U16LEfmt,
        scaling: { factor: 1, offset: 0, units: '', digits: 0 },
        orientation: 'row-major',
        provenance: 'imported',
        yAxis: { kind: 'referenced', address: saToFo(axisPtr + 1), count, format: U8fmt },
      });
      isolate();
    }

    // fwdAdj (tier 6, forward): `[prefix][axis run][data]`, axis ending
    // EXACTLY at the data SA. Alternates the prefix width aw (u8/u16). Axis
    // CELL values (not the count prefix) are chosen >= 100 for BOTH widths:
    //  - aw=1: the last cell sits at sa-1 (the high byte of the tier-0/5
    //    backward "header" read at sa-2); a value >= 0x60 forces that 2-byte
    //    read past MS41_CAL_SA_MAX, so tier 0/5 can never mistake this SA for
    //    a header curve (guarantees the "sa-2 not a valid backward header"
    //    requirement structurally, not by zeroing).
    //  - aw=2: cell values < 256 keep the LE high byte 0 on every cell, so
    //    validateAxisPtr's width-1 attempt (tried FIRST, always — the
    //    escalation risk called out in the task brief) reads an
    //    alternating [0, cellLow, 0, cellLow, ...] stream. cellLow >= 100
    //    makes the SECOND transition (cellLow -> 0) a direction REVERSAL
    //    (cellLow > 0 rising, then falling to 0), tripping the "broke" guard
    //    in validateAxisPtr for any count >= 3 and rejecting width-1
    //    immediately — letting the true width-2 interpretation surface.
    //  Both properties also make every cell value structurally incapable of
    //  being misread as a valid tier-6 count elsewhere (counts top out at
    //  axis.maxCount 64), which is what keeps this plant safe from its OWN
    //  combinatorial c/aw sweep landing on a spurious shorter match.
    let awToggle = 0;
    for (let j = 0; j < fwdAdj; j++) {
      const aw: 1 | 2 = awToggle++ % 2 === 0 ? 1 : 2;
      const w: 1 | 2 = wToggle++ % 2 === 0 ? 1 : 2;
      const targetCpu = w === 1 ? CURVE_A_CPU : CURVE_B_CPU;
      const c = aw === 2 ? randInt(4, 8) : randInt(4, 10);
      const p = cursor;
      const axisDataSA = p + aw;
      const sa = axisDataSA + c * aw;
      const cells: number[] = [];
      let v = randInt(100, 150);
      for (let i = 0; i < c; i++) {
        cells.push(v);
        v += randInt(1, 9); // strictly increasing, stays well under the u8/LE-low-byte ceiling (255)
      }
      if (aw === 1) {
        putSA(p, [c]);
        putSA(axisDataSA, cells);
      } else {
        putSA(p, [c & 0xff, (c >> 8) & 0xff]);
        for (let i = 0; i < c; i++) putSA(axisDataSA + 2 * i, [cells[i]! & 0xff, (cells[i]! >> 8) & 0xff]);
      }
      const curveVals: number[] = [];
      for (let i = 0; i < c * w; i++) curveVals.push(randInt(0, 255));
      putSA(sa, curveVals);
      cursor = sa + c * w;

      writeCallSite(o, sa, targetCpu);
      o += 8;

      maps.push({
        id: `synthc-fb-${spec.seed}-fwdAdj-0x${sa.toString(16)}`,
        name: `Synthetic Fallback Fwd-Adjacency Curve 0x${sa.toString(16)}`,
        address: saToFo(sa),
        rows: c,
        cols: 1,
        format: w === 1 ? U8fmt : U16LEfmt,
        scaling: { factor: 1, offset: 0, units: '', digits: 0 },
        orientation: 'row-major',
        provenance: 'imported',
        yAxis: { kind: 'referenced', address: saToFo(axisDataSA), count: c, format: aw === 1 ? U8fmt : U16LEfmt },
      });
      isolate();
    }

    // revAdj (tier 6, reversed): `[data][prefix][axis]`, prefix+axis both u8
    // (mirrors the engine test's craftRevAdjCurve). Axis cell values >= 100
    // for the same self-collision-immunity reason as fwdAdj (never
    // misreadable as a valid tier-6 count, which tops out at axis.maxCount 64).
    for (let m = 0; m < revAdj; m++) {
      const w: 1 | 2 = wToggle++ % 2 === 0 ? 1 : 2;
      const targetCpu = w === 1 ? CURVE_A_CPU : CURVE_B_CPU;
      const c = randInt(4, 10);
      const sa = cursor;
      // CAVEAT (final review): revAdj curve-data cells are unconstrained
      // 0..255 — a future seed could by chance place a small count value at
      // sa + c'*w and steal the smallest-c match (the axis cells are >=100
      // by design, but the data cells are not collision-immune). Any such
      // seed fails CURVE_GATE loudly at gen time; do not assume structural
      // immunity when adding seeds.
      const curveVals: number[] = [];
      for (let i = 0; i < c * w; i++) curveVals.push(randInt(0, 255));
      putSA(sa, curveVals);
      const p = sa + c * w;
      const axisDataSA = p + 1;
      const axisVals = [c];
      let v = randInt(100, 150);
      for (let i = 0; i < c; i++) {
        axisVals.push(v);
        v += randInt(1, 9);
      }
      putSA(p, axisVals);
      cursor = axisDataSA + c;

      writeCallSite(o, sa, targetCpu);
      o += 8;

      maps.push({
        id: `synthc-fb-${spec.seed}-revAdj-0x${sa.toString(16)}`,
        name: `Synthetic Fallback Rev-Adjacency Curve 0x${sa.toString(16)}`,
        address: saToFo(sa),
        rows: c,
        cols: 1,
        format: w === 1 ? U8fmt : U16LEfmt,
        scaling: { factor: 1, offset: 0, units: '', digits: 0 },
        orientation: 'row-major',
        provenance: 'imported',
        yAxis: { kind: 'referenced', address: saToFo(axisDataSA), count: c, format: U8fmt },
      });
      isolate();
    }
  }

  return {
    bytes,
    truth: { fixture: `synth-curve-${spec.seed}`, binSha256: createBinImage(bytes, 'synth-curve').sha256, maps },
  };
}
