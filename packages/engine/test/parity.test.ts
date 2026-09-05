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
      digest: '7530873ecb68331cad3408388fb7aab0a2198dcc6296d3e94a4ffe3d4c130d62',
    });
  });
  it('synth-2 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-2')).toEqual({
      count: 65,
      digest: '34d3a86fe9ea9f295cac7fce1fb6aa28980539662f164e153e890a99291a8944',
    });
  });
  it('synth-pool-101 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-pool-101')).toEqual({
      count: 223,
      digest: '247edd1716fcb1f949e9140c9e6bd4dad49c74e4e31bedb42dc916d16f9e255b',
    });
  });
  it('synth-pool-103 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-pool-103')).toEqual({
      count: 193,
      digest: '6f6d5ed1c136a70452560ee91fe65f11ff4f82d2aa84e6c4e9fdef2a27022dd8',
    });
  });
});
