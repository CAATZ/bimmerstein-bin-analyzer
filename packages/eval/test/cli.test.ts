import { describe, expect, it } from 'vitest';
import { discoverFixtures, runHoldoutSeed, HOLDOUT_SPECS } from '../src/cli.js';
import { gateFor, SYNTH_GATE, POOL_GATE, MS41_GATE, CURVE_GATE, PARTIAL_GATE, PARTIAL_CURVE_GATE } from '../src/cli.js';
import { runHoldoutPoolSeed, HOLDOUT_POOL_SPECS } from '../src/cli.js';
import { runHoldoutPartialSeed, HOLDOUT_PCURVE_SPECS } from '../src/cli.js';
import { MS41_CURVE_GATE, MS41_ACCEPTANCE_CASES, meetsGate, runAcceptance } from '../src/cli.js';
import { MS41_PARTIAL_GATE, MS41_PARTIAL_ACCEPTANCE_CASES } from '../src/cli.js';
import { MS41_CHECKSUM_CASES } from '../src/cli.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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

  it('accounts for EVERY case it could not run, so the summary cannot read as full coverage', () => {
    // Exit 0 alone would still hold if the checksum loop were short-circuited
    // by the missing-definition early return again — the skip lines are what
    // prove each of the ten cases was considered and named.
    const root = mkdtempSync(join(tmpdir(), 'binacc-'));
    mkdirSync(join(root, 'fixtures', 'ms41'), { recursive: true });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]): void => void lines.push(a.join(' '));
    try {
      expect(runAcceptance(root)).toBe(0);
    } finally {
      console.log = log;
    }
    const out = lines.join('\n');
    for (const c of MS41_CHECKSUM_CASES) expect(out).toContain(`${c.key} (checksums`);
    for (const c of MS41_ACCEPTANCE_CASES) expect(out).toContain(`${c.key} (full`);
    for (const c of MS41_PARTIAL_ACCEPTANCE_CASES) expect(out).toContain(`${c.key} (partial`);
    expect(out).toContain('nothing to check');
  });

  it('binds EVERY MS41_PARTIAL_GATE entry to a partial acceptance case', () => {
    // Same anti-orphan guard as the full-read case above. The partial floors
    // previously existed ONLY as prose in a doc comment and in a gitignored
    // controller script — never as constants, so nothing could evaluate them.
    expect(MS41_PARTIAL_ACCEPTANCE_CASES.map((c) => c.key).sort()).toEqual(Object.keys(MS41_PARTIAL_GATE).sort());
  });

  it('holds the s52 partial curve floor at ZERO tolerance — losing one of the 60 curves fails', () => {
    // s52 partial curve truth is 71 maps, so recall moves in whole maps of
    // 1/71 ≈ 0.0141 — there is no such thing as a fractional regression here.
    // P3.1-S1 delivered 60/71 = 0.845; the floor is ratcheted to admit exactly
    // that and nothing less, so any lost curve fails rather than being absorbed
    // by slack. (The pre-ratchet 0.80 floor tolerated losing three.)
    const g = MS41_PARTIAL_GATE.s52.curve;
    const base = { axisRecall: 0.983, falsePositiveDensity: 0, truthCount: 71, detectedCount: 432 };
    const recall = (maps: number): number => maps / 71;
    expect(meetsGate({ locationRecall: recall(60), structureRecall: recall(60), ...base }, g)).toBe(true);
    expect(meetsGate({ locationRecall: recall(59), structureRecall: recall(60), ...base }, g)).toBe(false);
    expect(meetsGate({ locationRecall: recall(60), structureRecall: recall(59), ...base }, g)).toBe(false);
  });

  it('holds the s52 partial curve AXIS floor at zero tolerance — one wrong axis fails', () => {
    // Axis recall divides by axis-ELIGIBLE structure hits, not by truth count:
    // measured 59/60 = 0.9833 (all 60 structure hits carry a referenced axis,
    // so the denominator is 60, not 71). Granularity is therefore 1/60 ≈
    // 0.0167 and the floor is a whole-axis count: 0.95 tolerated TWO axes
    // going wrong, 0.98 tolerates none.
    const g = MS41_PARTIAL_GATE.s52.curve;
    const base = { locationRecall: 60 / 71, structureRecall: 60 / 71, falsePositiveDensity: 0, truthCount: 71, detectedCount: 432 };
    expect(meetsGate({ ...base, axisRecall: 59 / 60 }, g)).toBe(true);
    expect(meetsGate({ ...base, axisRecall: 58 / 60 }, g)).toBe(false);
  });

  it('holds the e36m3 partial curve AXIS floor at zero tolerance too', () => {
    // e36m3's denominator differs from s52's: 58 axis-eligible structure hits
    // (58/64 struct) vs s52's 60. Measured 57/58 = 0.9828, granularity
    // 1/58 ≈ 0.0172 — 0.95 tolerated one wrong axis, 0.98 tolerates none.
    const g = MS41_PARTIAL_GATE.e36m3.curve;
    const base = { locationRecall: 58 / 64, structureRecall: 58 / 64, falsePositiveDensity: 0, truthCount: 64, detectedCount: 396 };
    expect(meetsGate({ ...base, axisRecall: 57 / 58 }, g)).toBe(true);
    expect(meetsGate({ ...base, axisRecall: 56 / 58 }, g)).toBe(false);
  });

  it('holds both partial GRID axis floors at zero tolerance', () => {
    // Measured denominators are NOT the structure-hit counts: one truth map
    // per bin takes a structure hit while carrying no referenced axis, so
    // axis-eligible is 54 (e36m3, struct 55) and 59 (s52, struct 60). Hence
    // 53/54 = 0.9815 and 58/59 = 0.9831 — never infer these from the 3-dp
    // printed value, which hides which denominator is in play.
    const e = MS41_PARTIAL_GATE.e36m3.grid;
    const s = MS41_PARTIAL_GATE.s52.grid;
    const eBase = { locationRecall: 60 / 62, structureRecall: 55 / 62, falsePositiveDensity: 0, truthCount: 62, detectedCount: 396 };
    const sBase = { locationRecall: 65 / 68, structureRecall: 60 / 68, falsePositiveDensity: 0, truthCount: 68, detectedCount: 432 };
    expect(meetsGate({ ...eBase, axisRecall: 53 / 54 }, e)).toBe(true);
    expect(meetsGate({ ...eBase, axisRecall: 52 / 54 }, e)).toBe(false);
    expect(meetsGate({ ...sBase, axisRecall: 58 / 59 }, s)).toBe(true);
    expect(meetsGate({ ...sBase, axisRecall: 57 / 59 }, s)).toBe(false);
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

describe('real-bin checksum acceptance', () => {
  it('covers both framings — a full read and a partial for each real bin', () => {
    // Checksum coverage differs by framing: a partial carries only the cal
    // table. Both must be exercised or the partial path is unguarded.
    expect(MS41_CHECKSUM_CASES.map((c) => c.key).sort()).toEqual(
      ['e36m3-full', 'e36m3-partial', 's52-full', 's52-partial'].sort()
    );
  });

  it('every case names a bin path under fixtures/ms41', () => {
    for (const c of MS41_CHECKSUM_CASES) {
      expect(c.bin).toMatch(/\.bin$/);
      // The paths are joined onto fixtures/ms41, so a traversal segment or an
      // absolute path would silently read from somewhere else entirely — which
      // "under fixtures/ms41" is exactly the claim this test makes.
      expect(c.bin).not.toMatch(/(^|[\\/])\.\.([\\/]|$)/);
      expect(isAbsolute(c.bin)).toBe(false);
    }
  });

  it('every case pins WHICH blocks are stale, consistently with how many', () => {
    // A count-only pin is blind to a permutation: a change that makes a
    // DIFFERENT calibration entry stale while keeping the total identical would
    // pass silently, and the identity of the stale entries is the whole point of
    // the two s52 pins. This also catches a hand-mistyped pin, since the two
    // halves must agree.
    for (const c of MS41_CHECKSUM_CASES) {
      expect(c.staleIds).toBeDefined();
      expect(c.staleIds.length, `${c.key} staleIds vs ok/total`).toBe(c.totalBlocks - c.okBlocks);
      expect(new Set(c.staleIds).size, `${c.key} staleIds has duplicates`).toBe(c.staleIds.length);
    }
  });

  it('pins the s52 images as the known-stale ones and both e36m3 images as clean', () => {
    // Guards the direction of the ratchet: if a future edit "fixed" the pins by
    // blanking them, this fails rather than quietly widening what passes.
    const byKey = Object.fromEntries(MS41_CHECKSUM_CASES.map((c) => [c.key, c.staleIds]));
    expect(byKey['e36m3-full']).toEqual([]);
    expect(byKey['e36m3-partial']).toEqual([]);
    // program joined the stale list when the checksum became a BLOCK we verify
    // but never write; positional in report order, so it precedes cal-0.
    expect(byKey['s52-full']).toEqual(['program', 'cal-0']);
    expect(byKey['s52-partial']).toEqual(['cal-4', 'cal-6', 'cal-14']);
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
