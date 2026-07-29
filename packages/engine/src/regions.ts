import type { ScanConfig } from './config.js';

/**
 * Stage 1 — Region classification (spec §4.1).
 * Sliding-window features (Shannon entropy, fill-byte fraction, histogram
 * concentration, 16-bit repetitiveness) → labeled ranges. Deterministic.
 * Implemented in plan Phase 2 (TDD).
 */
export type RegionKind = 'empty' | 'code' | 'data';

export interface Region {
  start: number;
  /** exclusive */
  end: number;
  kind: RegionKind;
}

export function classifyRegions(bytes: Uint8Array, config: ScanConfig): Region[] {
  const { windowBytes, stepBytes, codeEntropyMin, emptyFillMin } = config.region;
  if (bytes.length === 0) return [];
  const counts = new Uint32Array(256);
  const labels: RegionKind[] = [];
  for (let start = 0; start < bytes.length; start += stepBytes) {
    // window anchored at the step block, clamped to the bin
    const end = Math.min(start + windowBytes, bytes.length);
    counts.fill(0);
    for (let i = start; i < end; i++) counts[bytes[i]!]!++;
    const total = end - start;
    const fill = (counts[0x00]! + counts[0xff]!) / total;
    let entropy = 0;
    for (let b = 0; b < 256; b++) {
      const c = counts[b]!;
      if (c > 0) {
        const p = c / total;
        entropy -= p * Math.log2(p);
      }
    }
    labels.push(fill >= emptyFillMin ? 'empty' : entropy >= codeEntropyMin ? 'code' : 'data');
  }
  const regions: Region[] = [];
  for (let i = 0; i < labels.length; i++) {
    const start = i * stepBytes;
    const end = Math.min(start + stepBytes, bytes.length);
    const kind = labels[i]!;
    const last = regions[regions.length - 1];
    if (last && last.kind === kind) last.end = end;
    else regions.push({ start, end, kind });
  }
  return regions;
}
