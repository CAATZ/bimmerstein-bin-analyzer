import { describe, expect, it } from 'vitest';
import { discoverFixtures, runHoldoutSeed, HOLDOUT_SPECS } from '../src/cli.js';
import { gateFor, SYNTH_GATE, POOL_GATE, MS41_GATE, CURVE_GATE, PARTIAL_GATE, PARTIAL_CURVE_GATE } from '../src/cli.js';
import { runHoldoutPoolSeed, HOLDOUT_POOL_SPECS } from '../src/cli.js';
import { runHoldoutPartialSeed, HOLDOUT_PCURVE_SPECS } from '../src/cli.js';
import { MS41_CURVE_GATE, MS41_ACCEPTANCE_CASES, meetsGate, runAcceptance } from '../src/cli.js';
import { MS41_PARTIAL_GATE, MS41_PARTIAL_ACCEPTANCE_CASES } from '../src/cli.js';
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

describe('real-bin acceptance (pnpm eval accept)', () => {
  it('binds EVERY MS41_CURVE_GATE entry to an acceptance case', () => {
    // Regression guard for the defect this command exists to fix:
    // MS41_CURVE_GATE shipped with ZERO consumers anywhere in the tracked
    // tree — its own declaration was the only occurrence. Real-bin 1D-curve
    // recall was therefore checked by a human reading printed numbers out of
    // a gitignored script, so a curve regression passed `pnpm test`,
    // `pnpm eval`, `pnpm eval holdout` and CI in silence. A gate nobody
    // evaluates is not a gate. Adding a bin to the gate without adding its
    // acceptance case must fail here.
    expect(MS41_ACCEPTANCE_CASES.map((c) => c.key).sort()).toEqual(Object.keys(MS41_CURVE_GATE).sort());
  });

  it('enforces the gate rather than merely reporting it — a below-floor score FAILS', () => {
    // s52's floor is 0.95/0.95/0.95; 0.94 location must not pass.
    expect(meetsGate({ locationRecall: 0.958, structureRecall: 0.958, axisRecall: 0.971,
      falsePositiveDensity: 0, truthCount: 71, detectedCount: 4616 }, MS41_CURVE_GATE.s52)).toBe(true);
    expect(meetsGate({ locationRecall: 0.94, structureRecall: 0.958, axisRecall: 0.971,
      falsePositiveDensity: 0, truthCount: 71, detectedCount: 4616 }, MS41_CURVE_GATE.s52)).toBe(false);
  });

  it('skips cleanly (exit 0) when the gitignored real fixtures are absent — CI must stay green', () => {
    const root = mkdtempSync(join(tmpdir(), 'binacc-'));
    mkdirSync(join(root, 'fixtures', 'ms41'), { recursive: true });
    expect(runAcceptance(root)).toBe(0);
  });

  it('binds EVERY MS41_PARTIAL_GATE entry to a partial acceptance case', () => {
    // Same anti-orphan guard as the full-read case above. The partial floors
    // previously existed ONLY as prose in a doc comment and in a gitignored
    // controller script — never as constants, so nothing could evaluate them.
    expect(MS41_PARTIAL_ACCEPTANCE_CASES.map((c) => c.key).sort()).toEqual(Object.keys(MS41_PARTIAL_GATE).sort());
  });

  it('gates partials on BOTH truth classes — a grid regression must not hide behind curve recall', () => {
    // Partials are scored against grid AND curve truth. Unlike full reads,
    // neither class is covered by runEval (no groundtruth.json is committed
    // for them), so both floors have to bind here or one is unguarded.
    const g = MS41_PARTIAL_GATE.e36m3;
    const ok = { falsePositiveDensity: 0, truthCount: 62, detectedCount: 396 };
    // as-measured e36m3 partial: grid 0.968/0.887/0.981, curve 0.906/0.906/0.983
    expect(meetsGate({ locationRecall: 0.968, structureRecall: 0.887, axisRecall: 0.981, ...ok }, g.grid)).toBe(true);
    expect(meetsGate({ locationRecall: 0.906, structureRecall: 0.906, axisRecall: 0.983, ...ok }, g.curve)).toBe(true);
    // a grid structure regression below the 0.85 floor must fail
    expect(meetsGate({ locationRecall: 0.968, structureRecall: 0.84, axisRecall: 0.981, ...ok }, g.grid)).toBe(false);
    // and a curve regression below the 0.90 floor must fail
    expect(meetsGate({ locationRecall: 0.89, structureRecall: 0.906, axisRecall: 0.983, ...ok }, g.curve)).toBe(false);
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
