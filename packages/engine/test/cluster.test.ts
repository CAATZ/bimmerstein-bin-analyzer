import { describe, expect, it } from 'vitest';
import { detectClusterCandidates } from '../src/cluster.js';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import type { Region } from '../src/regions.js';

/** four 4×4 u8 sub-blocks (smooth ramp) separated by 4-byte high-contrast runs. */
function plantCluster(bytes: Uint8Array): void {
  for (const base of [0, 20, 40, 60])
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) bytes[base + r * 4 + c] = 40 + r * 2 + c;
  for (const s of [16, 36, 56]) bytes.set([200, 10, 200, 10], s); // separators at stride 20
}

describe('detectClusterCandidates', () => {
  it('emits the aligned sub-blocks of a periodic separator cluster', () => {
    const bytes = new Uint8Array(80);
    plantCluster(bytes);
    const regions: Region[] = [{ start: 0, end: 76, kind: 'data' }];
    const found = detectClusterCandidates(bytes, regions, DEFAULT_SCAN_CONFIG);
    // the two interior sub-blocks are cleanly bounded → exact 4×4
    expect(found.some((t) => t.address === 20 && t.rows === 4 && t.cols === 4)).toBe(true);
    expect(found.some((t) => t.address === 40 && t.rows === 4 && t.cols === 4)).toBe(true);
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const t of found) {
      expect(t.cluster).toBe(true);
      expect(t.format.width).toBe(1);
    }
  });

  it('emits nothing without a periodic separator run', () => {
    const bytes = new Uint8Array(128);
    for (let i = 0; i < 128; i++) bytes[i] = 40 + (i % 16); // smooth, no high-contrast stride
    const found = detectClusterCandidates(bytes, [{ start: 0, end: 128, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    expect(found).toEqual([]);
  });

  it('ignores clusters with fewer than minReps separators', () => {
    const bytes = new Uint8Array(64);
    for (const base of [0, 20]) for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) bytes[base + r * 4 + c] = 40 + r * 2 + c;
    bytes.set([200, 10, 200, 10], 16); // only ONE separator → 1 < minReps 3
    const found = detectClusterCandidates(bytes, [{ start: 0, end: 40, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    expect(found).toEqual([]);
  });
});
