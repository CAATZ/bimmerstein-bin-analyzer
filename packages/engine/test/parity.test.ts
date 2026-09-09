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
      count: 23,
      digest: '645bbd711cd9ab3f17cdda25fe4749d617e53342028a5f2ebb87a5d70b416040',
    });
  });
  it('synth-2 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-2')).toEqual({
      count: 63,
      digest: '2399522d3b4e20628daf586326c3a0f929e114befd03a9aa9d3ec3b2c652c29f',
    });
  });
  it('synth-pool-101 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-pool-101')).toEqual({
      count: 199,
      digest: '3ac74b2dab771a2f3e8169e943a2e592315fe06b6eb4cd4bc0fa3be990842d43',
    });
  });
  it('synth-pool-103 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-pool-103')).toEqual({
      count: 171,
      digest: '26217a784ccb54ba612fe23a3424a10d1bec71feb9d1d4796e5bb22e1b6c0f74',
    });
  });
});
