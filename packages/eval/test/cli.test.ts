import { describe, expect, it } from 'vitest';
import { discoverFixtures, runHoldoutSeed, HOLDOUT_SPECS } from '../src/cli.js';
import { gateFor, SYNTH_GATE, POOL_GATE, MS41_GATE, CURVE_GATE, PARTIAL_GATE, PARTIAL_CURVE_GATE } from '../src/cli.js';
import { runHoldoutPoolSeed, HOLDOUT_POOL_SPECS } from '../src/cli.js';
import { runHoldoutPartialSeed, HOLDOUT_PCURVE_SPECS } from '../src/cli.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('discoverFixtures', () => {
  it('finds directories containing a bin + matching groundtruth', () => {
    const root = mkdtempSync(join(tmpdir(), 'binfx-'));
    const dir = join(root, 'family');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.bin'), Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, 'a.groundtruth.json'), '{}');
    writeFileSync(join(dir, 'orphan.bin'), Buffer.from([1]));
    const found = discoverFixtures(root);
    expect(found).toEqual([{ bin: join(dir, 'a.bin'), truth: join(dir, 'a.groundtruth.json') }]);
  });
});

describe('holdout', () => {
  // Full in-memory scan of a 131 KB bin with phase probing — allow generous time.
  it('scores an unseen seed in memory with the right truth count', { timeout: 30_000 }, () => {
    const spec = HOLDOUT_SPECS[0]!; // { seed: 3, sizeBytes: 131072, mapCount: 10 }
    const r = runHoldoutSeed(spec);
    expect(r.truthCount).toBe(10);
    expect(r.fixture).toBe('synth-3');
    expect(r.locationRecall).toBeGreaterThanOrEqual(0);
    expect(r.locationRecall).toBeLessThanOrEqual(1);
  });
});

describe('gateFor (per-family gate dispatch)', () => {
  it('selects the pool gate for synth-pool fixtures before the synth prefix matches', () => {
    expect(gateFor('synth-pool-101')).toBe(POOL_GATE);
    expect(gateFor('synth-1')).toBe(SYNTH_GATE);
    expect(gateFor('ms41-e36m3-stock')).toBe(MS41_GATE);
    expect(gateFor('ms41-s52-ss1v2-stock')).toBe(MS41_GATE);
    expect(gateFor('e36m3-other')).toBeUndefined();
  });

  it('selects the curve gate for synth-curve fixtures before the generic synth prefix matches', () => {
    expect(gateFor('synth-curve-301')).toBe(CURVE_GATE);
    expect(gateFor('synth-curve-302')).toBe(CURVE_GATE);
    expect(gateFor('synth-1')).toBe(SYNTH_GATE); // unaffected: still the generic-synth gate
  });

  it('selects the partial-curve gate for synth-pcurve fixtures without disturbing the other prefixes', () => {
    expect(gateFor('synth-pcurve-401')).toBe(PARTIAL_CURVE_GATE);
    expect(gateFor('synth-pcurve-402')).toBe(PARTIAL_CURVE_GATE);
    // order regression: every neighboring prefix still routes to its own gate
    expect(gateFor('synth-partial-201')).toBe(PARTIAL_GATE);
    expect(gateFor('synth-pool-101')).toBe(POOL_GATE);
    expect(gateFor('synth-curve-301')).toBe(CURVE_GATE);
    expect(gateFor('synth-1')).toBe(SYNTH_GATE);
  });
});

describe('holdout pool seeds', () => {
  it('scores an unseen pool seed in memory', { timeout: 60_000 }, () => {
    const r = runHoldoutPoolSeed(HOLDOUT_POOL_SPECS[0]!); // seed 102
    expect(r.fixture).toBe('synth-pool-102');
    expect(r.truthCount).toBeGreaterThanOrEqual(15);
    expect(r.axisRecall).toBeGreaterThan(0); // the behavior this addendum exists for
  });
});

describe('holdout pcurve seeds', () => {
  it('scores an unseen partial-curve seed in memory', { timeout: 60_000 }, () => {
    const r = runHoldoutPartialSeed(HOLDOUT_PCURVE_SPECS[0]!); // seed 402
    expect(r.fixture).toBe('synth-pcurve-402');
    expect(r.truthCount).toBe(16);
    expect(r.locationRecall).toBeGreaterThan(0); // the channel this phase exists for
  });
});
