import type { MapDef } from '@binanalyzer/core';
import { DEFAULT_SCAN_CONFIG, type ScanConfig } from './config.js';
import { classifyRegions, type Region } from './regions.js';
import { scanAxes } from './axes.js';
import { scanTables } from './tables.js';
import { associate } from './associate.js';
import { rankAndEmit } from './score.js';
import { scanPrefixedAxes, isPoolActive, poolAdjacentTables } from './pool.js';
import { poolStructuralTables, poolStructuralActive } from './structural.js';
import { partialCurveDetections, headlessCurveDetections } from './partial-curves.js';
import { detectClusterCandidates } from './cluster.js';
import { runFamilyAnalyzers } from './family/index.js';

export * from './config.js';
export * from './regions.js';
export * from './axes.js';
export * from './tables.js';
export * from './associate.js';
export * from './score.js';
export * from './pool.js';
export * from './cluster.js';
export * from './family/ms41/frame.js';
export * from './family/ms41/c166.js';
export * from './family/ms41/header.js';
export * from './family/ms41/readers.js';
export * from './family/types.js';
export * from './family/ms41/analyzer.js';
export * from './family/ms41/curves.js';
export * from './family/index.js';
export * from './family/ms41/plateau.js';
export * from './family/ms41/params.js';
export * from './structural.js';
export * from './partial-curves.js';

export interface ScanProgress {
  stage: 'regions' | 'axes' | 'tables' | 'associate' | 'score';
  /** 0..1 within the whole scan. */
  fraction: number;
}

export interface ScanResult {
  regions: Region[];
  potentialMaps: MapDef[];
}

/**
 * Full pipeline (spec §4). Contracts: deterministic (same bytes+config →
 * identical output), progressive via onProgress, cancelable via signal —
 * checked between stages in v1.0 (finer-grained intra-stage checks arrive
 * with performance work). The engine is pure — callers own workers/threads.
 */
export function scan(
  bytes: Uint8Array,
  config: ScanConfig = DEFAULT_SCAN_CONFIG,
  onProgress?: (p: ScanProgress) => void,
  signal?: AbortSignal
): ScanResult {
  const check = (stage: ScanProgress['stage'], fraction: number): void => {
    if (signal?.aborted) throw new Error('scan aborted');
    onProgress?.({ stage, fraction });
  };
  check('regions', 0);
  const regions = classifyRegions(bytes, config);
  check('axes', 0.25);
  const axes = scanAxes(bytes, regions, config);
  check('tables', 0.45);
  const tables = scanTables(bytes, regions, config);
  const prefixed = scanPrefixedAxes(bytes, regions, config);
  // Family analyzers (spec §4.6): code-xref structure passes behind the
  // activation gate — [] on every off-family bin, so the pipeline below is
  // byte-identical there (committed parity digests prove it).
  const familyDetections = runFamilyAnalyzers(bytes, prefixed, config);
  // Cluster candidates (packed same-shape sibling tables) are a pool-layout
  // feature — they are only admitted to the pool tier. Gate their generation on
  // pool activation so the engine is provably unchanged on non-pool bins (the
  // synthetic families have < activateMinCount maximal prefixed axes → no
  // clusters → committed parity digests stay byte-stable).
  const poolActive = isPoolActive(prefixed, config);
  const clusters = poolActive ? detectClusterCandidates(bytes, regions, config) : [];
  const allTables = clusters.length > 0 ? [...tables, ...clusters] : tables;
  // Uniform adjacency-tight placement (dead tables) UNION the code-free
  // partial-structural detector (header sweep + packed tiling). poolStructuralTables
  // SELF-GATES (returns [] unless the bin is a small direct-framed cal partial with
  // the MS4x header signature AND isPoolActive), so every committed + holdout fixture
  // is byte-identical (parity digests unchanged). Both feed the same pool-structural
  // emission tier in rankAndEmit (above byte, below family). Guarded by poolActive so
  // no extra work runs on the common non-pool path. The activation gate's
  // header-density count is a whole-file sweep — computed ONCE here and shared
  // with poolStructuralTables and the Phase-3 partial-curve gate below.
  const structActive = poolActive && poolStructuralActive(bytes, prefixed, config);
  const poolTables = poolActive
    ? [...poolAdjacentTables(bytes, prefixed, config), ...poolStructuralTables(bytes, prefixed, config, structActive)]
    : [];
  check('associate', 0.85);
  const associated = associate(allTables, axes, config);
  check('score', 0.95);
  const maps0 = rankAndEmit(bytes, associated, axes, config, prefixed, familyDetections, poolTables);
  // Partial 1D-curve channel (Phase 3, spike docs/notes/ms41-p3-partial-curves-spike.md):
  // gate-active direct-SA partials ONLY (poolStructuralActive structurally
  // excludes full reads via STRUCT_MAX_BIN_LEN; the gate was computed once
  // above and shared). TWO-PASS by measurement: the discriminator consumes
  // the FIRST pass's trusted emissions, then rankAndEmit re-runs with the
  // curve tier — a single-pass shape is NOT output-equivalent (spike-refuted;
  // do not "optimize"). Gate-inactive bins return maps0 byte-identical, as do
  // gate-active bins where BOTH discriminators find nothing (the committed
  // synth-partials — pinned).
  if (structActive) {
    // P3.1-S1 (spike docs/notes/ms41-p31-headerless-spike.md): the headerless
    // overlay consumes the SAME first-pass maps0 — NEVER second-pass output
    // (its 1d emissions carry detector 'structural' and are neutralized only
    // by the incidental cols-1 demotion; skeptic finding). Tier 8 sorts after
    // tier 7 inside rankAndEmit's curve tier, so the shipped sweep emission
    // set is frozen by construction.
    const curves = [
      ...partialCurveDetections(bytes, maps0, prefixed, config),
      ...headlessCurveDetections(bytes, maps0, prefixed, config),
    ];
    if (curves.length > 0) {
      return {
        regions,
        potentialMaps: rankAndEmit(bytes, associated, axes, config, prefixed, familyDetections, poolTables, curves),
      };
    }
  }
  return { regions, potentialMaps: maps0 };
}
