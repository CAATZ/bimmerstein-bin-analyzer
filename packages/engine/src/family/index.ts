import type { ScanConfig } from '../config.js';
import type { PrefixedAxis } from '../pool.js';
import type { FamilyDetection } from './types.js';
import { ms41Analyzer } from './ms41/analyzer.js';

/**
 * Registry of pluggable family analyzers (spec §4.6). Order is the dispatch
 * order; every analyzer must be inert (return []) off-family, so running all
 * of them is safe and deterministic.
 */
export const FAMILY_ANALYZERS = [ms41Analyzer] as const;

export function runFamilyAnalyzers(
  bytes: Uint8Array,
  prefixedAxes: PrefixedAxis[],
  config: ScanConfig
): FamilyDetection[] {
  const out: FamilyDetection[] = [];
  for (const analyzer of FAMILY_ANALYZERS) out.push(...analyzer.analyze(bytes, prefixedAxes, config));
  return out;
}
