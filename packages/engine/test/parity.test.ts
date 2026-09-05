import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { DEFAULT_SCAN_CONFIG, scan } from '../src/index.js';
import { canonDigest } from './canon.js';

/**
 * Pins the engine's COMPLETE detection output (addresses, dims, formats, axis
 * addresses) on the committed synthetic fixtures. Behavior-identical refactors
 * must keep these digests stable; any intentional behavior change must update
 * them in the same commit WITH the eval movement that justifies it.
 */
function digestOf(fixture: string): { count: number; digest: string } {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../../fixtures/synthetic/${fixture}.bin`, import.meta.url))
  );
  return canonDigest(scan(bytes, DEFAULT_SCAN_CONFIG).potentialMaps);
}

describe('detection pinning (committed synthetic fixtures)', () => {
  it('synth-1 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-1')).toEqual({
      count: 24,
      digest: '96d43d07af013b92ec1f5123cf37085c816db23f2e04ee0e133d5ce5f0470bfe',
    });
  });
  it('synth-2 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-2')).toEqual({
      count: 66,
      digest: 'dee8f97345d5e08981fc287b5b63b0863a21808789e0e2555612d78e2dd6d330',
    });
  });
  it('synth-pool-101 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-pool-101')).toEqual({
      count: 241,
      digest: 'c9d62ca58f827e916ec707a7821e3e9be8abc20243193a1d015b60218fd6448b',
    });
  });
  it('synth-pool-103 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-pool-103')).toEqual({
      count: 210,
      digest: 'a3a542675d7d4b9edc6d395fc9201961b38ed32e2103b7cf78e72ebc99274918',
    });
  });
});
