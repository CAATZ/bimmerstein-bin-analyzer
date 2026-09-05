import type { SwitchState, ValueFormat } from '@binanalyzer/core';
import type { ScanConfig } from '../config.js';
import type { PrefixedAxis } from '../pool.js';

/**
 * Pluggable family analyzers (spec §4.6): family-specific structure passes
 * (e.g. MS41/C166 code-xref) behind a module boundary, so the generic
 * pipeline stays byte-heuristic. Analyzers are pure and deterministic like
 * every stage, and MUST return [] fast on off-family bins (activation gate).
 */
export interface FamilyDetection {
  /** FILE offset of the first data cell. */
  address: number;
  rows: number;
  cols: number;
  format: ValueFormat;
  /**
   * 0..1 frame-smoothness confidence. May be far below score.minConfidence —
   * stage 5 uses the family evidence tiers instead of that generic cutoff,
   * preserving code-referenced dead/flat tables and structural fallbacks.
   */
  score: number;
  /** Emission tier: grid tiers 0–3 (header > tight-fb > loose-fb > scan); the
   *  1D CURVE tier ranks below all grids (≥4) so a curve never displaces a grid. */
  tier: number;
  /** '1d' curves carry exactly one axis (see xAxis/yAxis); 'param' = 1×1
   *  code-referenced parameter (Switch Phase B — partitioned by rankAndEmit
   *  into the FINAL emission block, never the family loop); absent ⇒ '2d'. */
  kind?: '2d' | '1d' | 'param';
  /** Axis data addresses are FILE offsets (already frame-mapped). */
  xAxis?: { address: number; count: number; format: ValueFormat };
  yAxis?: { address: number; count: number; format: ValueFormat };
  /** Synthesized switch states (param tier, discrete-tested subclass only —
   *  register-still-holds-load discipline; spec 2026-07-23 Switch Phase B). */
  states?: SwitchState[];
}

export interface FamilyAnalyzer {
  /** Stable id, e.g. 'ms41'. */
  id: string;
  /** Full analysis including the activation gate; [] when the bin is off-family. */
  analyze(bytes: Uint8Array, prefixedAxes: PrefixedAxis[], config: ScanConfig): FamilyDetection[];
}
