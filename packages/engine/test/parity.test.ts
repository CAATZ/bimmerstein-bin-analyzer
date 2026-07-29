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
      digest: '720aa3199b4a5a4aa885c75d52456329d8255b272e6e5ebd29bf545ef59357c4',
    });
  });
  it('synth-2 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-2')).toEqual({
      count: 66,
      digest: '85225c932c047fa8a8a9fb69c0351b7e95e45cd8892d145777f6adb8962cd01d',
    });
  });
  it('synth-pool-101 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-pool-101')).toEqual({
      count: 238,
      digest: '2a7a351602e01a505e3e72ae4a5db3ff4ea3430fe086fc8d8e2ad8fa7b229483',
    });
  });
  it('synth-pool-103 output is stable', { timeout: 60_000 }, () => {
    expect(digestOf('synth-pool-103')).toEqual({
      count: 210,
      digest: '4853c53da61a5a766d1541f47c847951ff017f66ea3581fa2bc28e70a5379e09',
    });
  });
});
