/**
 * Eval CLI (spec §5). Subcommands:
 *   (default)            run engine over every fixture with a groundtruth.json,
 *                        print per-fixture score table, write eval-report.json
 *   gen-synthetic        (re)generate committed synthetic fixtures
 *   holdout              score unseen synthetic seeds (anti-overfitting check;
 *                        tuning-time only, NOT part of the committed-fixture gate)
 *   accept               enforce the real-bin gates the fixture table cannot:
 *                        MS41_CURVE_GATE on full reads (1D-curve truth class)
 *                        and MS41_PARTIAL_GATE on 24KB partials (both classes).
 *                        Binds only where the gitignored local fixtures exist;
 *                        skips and exits 0 otherwise (CI-safe)
 *   gt-from-romraider    build groundtruth.json from a RomRaider def XML + bin:
 *                        <def.xml> <bin> --fixture <n> --id-prefix <p> [--rom <xmlid>] [--fo] [--out <path>]
 * Exit code 1 when synthetic-fixture scores fall below targets (CI gate).
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBinImage, type MapDef } from '@binanalyzer/core';
import { DEFAULT_SCAN_CONFIG, scan } from '@binanalyzer/engine';
import { buildGroundTruth, type GtBuildOptions } from './gt-from-romraider.js';
import { parseGroundTruth } from './groundtruth.js';
import { scoreDetections, type EvalScores } from './metrics.js';
import {
  generateSynthetic,
  type SyntheticSpec,
  generatePoolSynthetic,
  type PoolSyntheticSpec,
  generatePartialSynthetic,
  type PartialSyntheticSpec,
  generateCurveSynthetic,
  type CurveSyntheticSpec,
} from './synthetic.js';

/**
 * Per-family synthetic gates. Adjacency family (synth-1/2, holdout 3–8):
 * mature thresholds + the axis ratchet (measured 0.92–1.00). Pool family
 * (synth-pool-*): RAISED by the 2026-07-09 stage-3 structure addendum
 * (struct 0.20→0.25, axis 0.85→0.90) — measured across 6 pool fixtures
 * (committed 101/103 + holdout 102/104/105/106): loc 0.65–0.86, struct
 * 0.30–0.70, axis 0.93–1.00, so the raised gate clears every fixture with
 * margin (min struct 0.30 on synth-pool-103, min axis 0.93 on synth-pool-101).
 * loc stays at 0.60 (its min, 0.65, has no headroom to raise). Ratchet only
 * ever moves up, never down (ratchet rule).
 */
export const SYNTH_GATE = { locationRecall: 0.9, structureRecall: 0.8, axisRecall: 0.85 };
export const POOL_GATE = { locationRecall: 0.6, structureRecall: 0.25, axisRecall: 0.9 };

/**
 * Real-MS41 acceptance gate (spec §5) — ENFORCED since the v2 code-xref
 * family analyzer landed (measured ≈0.97/0.94/1.00 e36m3, ≈0.88/0.81/1.00
 * s52; ample margin). Real bins are gitignored, so this binds only where the
 * local fixtures exist — CI (synthetic-only) never sees it.
 */
export const MS41_GATE = { locationRecall: 0.8, structureRecall: 0.6, axisRecall: 0.5 };

/**
 * Real-MS41 1D-curve acceptance gate (spec 2026-07-15 Phase 1, Task 6 plan;
 * raised by the Phase 1.1 fallback-tier plan, Task 4) — CONTROLLER-only, like
 * MS41_GATE: real bins are gitignored, so this binds only where the local
 * fixtures exist and is enforced by the controller during acceptance, NOT
 * wired into gateFor — real ms41-* fixture rows keep scoring against the
 * committed 2-axis GRID ground truth via MS41_GATE in CI unchanged.
 *
 * RAISED to the Phase 1.1 spike's measured V3 "safe ship shape" floors
 * (2026-07-15, docs/notes/ms41-p11-custom-curves-spike.md: tier-5
 * header-fallback at curveEmitMinCount + tier-6 forward/reversed axis
 * adjacency — exactly the tiers Tasks 1-3 landed; NOT the V4 tier-elevation
 * option, which the spike's skeptic review REFUTED as structurally unsafe —
 * see curves.ts's CURVE_FALLBACK_TIER/CURVE_ADJ_TIER doc comment). Measured
 * V3: e36m3 1.000/1.000/0.984 (curve rows, real scoreDetections against the
 * committed ground truth); s52 0.958/0.958/0.971. Floors are each measured
 * number rounded DOWN to the nearest 0.05, never above it (PARTIAL_GATE/
 * CURVE_GATE precedent): e36m3 axis 0.984 -> 0.98; s52 loc/struct 0.958 ->
 * 0.95, axis 0.971 -> 0.95.
 */
export const MS41_CURVE_GATE = {
  e36m3: { locationRecall: 1.0, structureRecall: 1.0, axisRecall: 0.98 },
  s52: { locationRecall: 0.95, structureRecall: 0.95, axisRecall: 0.95 },
};

/**
 * Partial-family gate. Structural-active synthetic direct-SA partials (the
 * out-of-sample CI guard that the partial-structural detector's ACTIVE path
 * lifts detection — real partials are gitignored, so CI never otherwise
 * exercises activation). Pinned from the FIRST gen-synthetic run's MEASURED
 * scores (2026-07-11 partial-structural plan, Task 5 Step 4): synth-partial-201
 * 1.000/1.000/1.000, synth-partial-203 0.9545/0.9545/1.000 (44 truth maps
 * each). Gate = per-metric lower of the two, rounded DOWN to the nearest
 * 0.05 — never above the honest measurement. Both fixtures are fully
 * deterministic (seeded LCG, no run-to-run variance), so a zero-margin axis
 * gate is exact, not brittle.
 */
export const PARTIAL_GATE = { locationRecall: 0.95, structureRecall: 0.95, axisRecall: 1.0 };

/**
 * Curve-family gate (spec 2026-07-15 Phase 1, Task 6 plan). Structural-active
 * synthetic 1D curves (the out-of-sample CI guard that the curve tier's
 * ACTIVATE path lifts detection — real curve-bearing MS41 bins are
 * gitignored, so CI never otherwise exercises the tier). Pinned from the
 * FIRST gen-synthetic run's MEASURED scores (2026-07-15 1D-curve plan, Task
 * 6 Step 4): synth-curve-301 (24 curves) and synth-curve-303 (26 curves) both
 * measured 1.0000/1.0000/1.0000 — the curve tier's header decode is exact
 * (never smoothness-gated), so perfect recovery of a well-formed planted
 * curve is the expected, not lucky, result. Gate = per-metric lower of the
 * two committed fixtures, rounded DOWN to the nearest 0.05 — never above the
 * honest measurement; here that is 1.0 itself (PARTIAL_GATE precedent: a
 * zero-margin gate is exact, not brittle, when every fixture is fully
 * deterministic with no run-to-run variance).
 *
 * Phase 1.1, Task 4 added synth-curve-305/307: the SAME fixtures plus
 * fallback-class plants (tier-5 header-low + tier-6 forward/reversed
 * adjacency, generateCurveSynthetic's fallbackPlants knob) exercising
 * detectMs41CurveFallbacks — also measured 1.0000/1.0000/1.0000 as-generated
 * (the fallback tiers' decode is exact too: a self-consistent planted
 * structure either resolves or it doesn't, no smoothness gate either way).
 * This value is UNCHANGED by that addition — the gate was already the exact
 * ceiling.
 */
export const CURVE_GATE = { locationRecall: 1.0, structureRecall: 1.0, axisRecall: 1.0 };

/**
 * Partial-curve family gate (Phase 3, spike docs/notes/
 * ms41-p3-partial-curves-spike.md). Structural-active synthetic direct-SA
 * partials carrying planted 1D-curve layouts (synth-pcurve-401/403) — the
 * out-of-sample CI guard that the partial-curve channel's ACTIVE path lifts
 * detection (real partials are gitignored, so CI never otherwise exercises
 * the two-pass emission). Pinned from the FIRST gen-synthetic run's MEASURED
 * scores (Phase-3 plan Task 4): both fixtures measured 1.0000/1.0000/1.0000 —
 * the planted layouts anchor exactly (pool-abut/adjax + pad-chain + bare
 * adjax) and the discriminator's decode is structural, not smoothness-gated,
 * so perfect recovery of a well-formed plant is the expected result. Gate =
 * per-metric min of the two committed fixtures rounded DOWN to the nearest
 * 0.05, never above the honest measurement (PARTIAL_GATE/CURVE_GATE
 * precedent); here that is 1.0 itself (deterministic seeded fixtures, no
 * run-to-run variance — a zero-margin gate is exact, not brittle).
 */
export const PARTIAL_CURVE_GATE = { locationRecall: 1.0, structureRecall: 1.0, axisRecall: 1.0 };

type Gate = typeof SYNTH_GATE;

export function gateFor(fixture: string): Gate | undefined {
  // 'synth-pcurve' would also match startsWith('synth') — checked first
  // (Phase-3 plan Task 4: order matters).
  if (fixture.startsWith('synth-pcurve')) return PARTIAL_CURVE_GATE;
  if (fixture.startsWith('synth-pool')) return POOL_GATE;
  if (fixture.startsWith('synth-partial')) return PARTIAL_GATE;
  // 'synth-curve' also matches startsWith('synth') — must be checked first.
  if (fixture.startsWith('synth-curve')) return CURVE_GATE;
  if (fixture.startsWith('synth')) return SYNTH_GATE;
  if (fixture.startsWith('ms41')) return MS41_GATE;
  return undefined;
}

/**
 * Real-MS41 PARTIAL acceptance gate (spec Phase-3 addendum + P3.1-S1).
 *
 * A 24 KB cal partial contains no code, so the code-xref family analyzer is
 * structurally inactive and detection runs entirely through the pool /
 * structural / partial-curve tiers. Those tiers are exercised on real data
 * ONLY here: no partial fixture carries a committed groundtruth.json, so
 * `runEval` never scores one, and NEITHER truth class is covered by MS41_GATE.
 * Both floors therefore bind in this command or they bind nowhere — which is
 * exactly the state these values were in before, existing only as prose in a
 * doc comment and in a gitignored controller script.
 *
 * Values are the ALREADY-AGREED controller floors, transcribed unchanged, not
 * re-derived: curve e36m3 >= 0.90/0.90, s52 >= 0.80/0.80, axis >= 0.95; grid
 * >= 0.95/0.85. The grid AXIS floor is the one number the prose left implicit;
 * it is pinned at 0.95 to match the curve axis floor, which is below the
 * measured 0.981/0.983 and consistent with the round-DOWN convention used by
 * PARTIAL_GATE and CURVE_GATE.
 *
 * As-measured when pinned (P3.1-S1 as-wired, matches the recorded as-executed
 * numbers exactly): e36m3 grid 0.968/0.887/0.981 curve 0.906/0.906/0.983
 * (det 396); s52 grid 0.956/0.882/0.983 curve 0.845/0.845/0.983 (det 432).
 * Two margins are deliberately thin — e36m3 curve loc/struct and s52 grid loc
 * both clear by 0.006 — which is safe because a real bin scanned by a
 * deterministic engine has no run-to-run variance (the PARTIAL_GATE precedent:
 * a tight gate is exact, not brittle). Raising s52's curve floor toward its
 * measured 0.845 stays an open user-adjudicated option, deliberately NOT taken
 * here: a ratchet moves up only on a decision, never as a side effect.
 */
export const MS41_PARTIAL_GATE = {
  e36m3: {
    curve: { locationRecall: 0.9, structureRecall: 0.9, axisRecall: 0.95 },
    grid: { locationRecall: 0.95, structureRecall: 0.85, axisRecall: 0.95 },
  },
  s52: {
    curve: { locationRecall: 0.8, structureRecall: 0.8, axisRecall: 0.95 },
    grid: { locationRecall: 0.95, structureRecall: 0.85, axisRecall: 0.95 },
  },
};

/**
 * One real-bin acceptance case: a local (gitignored) firmware fixture, the
 * definition rom it is scored against, and the gate its 1D-curve scores must
 * meet. Kept here rather than discovered, because the rom id cannot be
 * inferred from the filesystem.
 *
 * The `key` is checked against MS41_CURVE_GATE's own keys by a unit test, so a
 * gate entry can never again exist with nothing evaluating it.
 */
export interface AcceptanceCase {
  key: keyof typeof MS41_CURVE_GATE;
  /** Filename inside fixtures/ms41/ (gitignored — real firmware). */
  bin: string;
  romId: string;
  gate: Gate;
}

export const MS41_ACCEPTANCE_CASES: AcceptanceCase[] = [
  { key: 'e36m3', bin: 'E36 M3 Stock Full Read.bin', romId: '12', gate: MS41_CURVE_GATE.e36m3 },
  { key: 's52', bin: 'MS41.3 S52 Stock Full Read.bin', romId: 'SS1v2', gate: MS41_CURVE_GATE.s52 },
];

/**
 * A real 24 KB cal PARTIAL acceptance case. Scored against BOTH truth classes
 * (see MS41_PARTIAL_GATE) with applyFo FALSE — on a direct-SA partial a
 * storageaddress already IS the file offset, so the full read's flash-bus
 * descramble must not be applied.
 */
export interface PartialAcceptanceCase {
  key: keyof typeof MS41_PARTIAL_GATE;
  /** Filename inside fixtures/ms41/partial/ (gitignored — real firmware). */
  bin: string;
  romId: string;
  curveGate: Gate;
  gridGate: Gate;
}

export const MS41_PARTIAL_ACCEPTANCE_CASES: PartialAcceptanceCase[] = [
  {
    key: 'e36m3',
    bin: 'E36 M3 Stock partial.bin',
    romId: '12',
    curveGate: MS41_PARTIAL_GATE.e36m3.curve,
    gridGate: MS41_PARTIAL_GATE.e36m3.grid,
  },
  {
    key: 's52',
    bin: 'MS41.3 S52 Stock partial.bin',
    romId: 'SS1v2',
    curveGate: MS41_PARTIAL_GATE.s52.curve,
    gridGate: MS41_PARTIAL_GATE.s52.grid,
  },
];

/** Source definition for the acceptance ground truth (gitignored, third-party). */
const MS41_ACCEPTANCE_DEF = 'fixtures/ms41/defs/2023 MS41 ECU Definitions.xml';

export function meetsGate(s: EvalScores, g: Gate): boolean {
  return (
    s.locationRecall >= g.locationRecall &&
    s.structureRecall >= g.structureRecall &&
    s.axisRecall >= g.axisRecall
  );
}

/**
 * Held-out synthetic seeds — never committed as fixtures. Tuning that passes
 * the two committed fixtures must also pass these unseen seeds, or it is
 * overfitting (never tune against the gate fixtures alone).
 */
export const HOLDOUT_SPECS: SyntheticSpec[] = [
  { seed: 3, sizeBytes: 131072, mapCount: 10 },
  { seed: 4, sizeBytes: 196608, mapCount: 14 },
  { seed: 5, sizeBytes: 262144, mapCount: 18 },
  { seed: 6, sizeBytes: 131072, mapCount: 8 },
  { seed: 7, sizeBytes: 196608, mapCount: 20 },
  { seed: 8, sizeBytes: 262144, mapCount: 12 },
];

export function runHoldoutSeed(spec: SyntheticSpec): { fixture: string } & EvalScores {
  const { bytes, truth } = generateSynthetic(spec);
  const result = scan(bytes, DEFAULT_SCAN_CONFIG);
  const dataBytes = result.regions.filter((r) => r.kind === 'data').reduce((s, r) => s + (r.end - r.start), 0);
  return { fixture: truth.fixture, ...scoreDetections(result.potentialMaps, truth.maps, dataBytes) };
}

/** Committed pool-family gate fixtures (written by gen-synthetic). */
const POOL_FIXTURE_SPECS: PoolSyntheticSpec[] = [
  { seed: 101, sizeBytes: 196608, groupCount: 7 },
  { seed: 103, sizeBytes: 196608, groupCount: 7 },
];

/** Held-out pool-family seeds — never committed (anti-overfitting, like seeds 3–8). */
export const HOLDOUT_POOL_SPECS: PoolSyntheticSpec[] = [
  { seed: 102, sizeBytes: 196608, groupCount: 7 },
  { seed: 104, sizeBytes: 196608, groupCount: 7 },
  { seed: 105, sizeBytes: 196608, groupCount: 7 },
  { seed: 106, sizeBytes: 196608, groupCount: 7 },
];

export function runHoldoutPoolSeed(spec: PoolSyntheticSpec): { fixture: string } & EvalScores {
  const { bytes, truth } = generatePoolSynthetic(spec);
  const result = scan(bytes, DEFAULT_SCAN_CONFIG);
  const dataBytes = result.regions.filter((r) => r.kind === 'data').reduce((s, r) => s + (r.end - r.start), 0);
  return { fixture: truth.fixture, ...scoreDetections(result.potentialMaps, truth.maps, dataBytes) };
}

/** Committed partial-family gate fixtures (written by gen-synthetic). */
const PARTIAL_FIXTURE_SPECS: PartialSyntheticSpec[] = [
  { seed: 201, sizeBytes: 0x6000, tableCount: 44 },
  { seed: 203, sizeBytes: 0x6000, tableCount: 44 },
];

/** Held-out partial seeds — never committed (anti-overfitting, like seeds 3–8 / 102–106). */
export const HOLDOUT_PARTIAL_SPECS: PartialSyntheticSpec[] = [
  { seed: 202, sizeBytes: 0x6000, tableCount: 40 },
  { seed: 204, sizeBytes: 0x6000, tableCount: 48 },
];

export function runHoldoutPartialSeed(spec: PartialSyntheticSpec): { fixture: string } & EvalScores {
  const { bytes, truth } = generatePartialSynthetic(spec);
  const result = scan(bytes, DEFAULT_SCAN_CONFIG);
  const dataBytes = result.regions.filter((r) => r.kind === 'data').reduce((sum, r) => sum + (r.end - r.start), 0);
  return { fixture: truth.fixture, ...scoreDetections(result.potentialMaps, truth.maps, dataBytes) };
}

/** Committed partial-curve gate fixtures (written by gen-synthetic; Phase 3). */
const PCURVE_FIXTURE_SPECS: PartialSyntheticSpec[] = [
  { seed: 401, sizeBytes: 0x6000, tableCount: 44, curvePlants: { plants: 12 } },
  { seed: 403, sizeBytes: 0x6000, tableCount: 44, curvePlants: { plants: 12 } },
];

/** Held-out partial-curve seeds — never committed (anti-overfitting, like 202/204 etc.).
 *  Scored by runHoldoutPartialSeed: a pcurve spec IS a PartialSyntheticSpec
 *  (curvePlants set), and generatePartialSynthetic returns the right fixture
 *  name + curve-only truth for it — a separate runner would be a duplicate. */
export const HOLDOUT_PCURVE_SPECS: PartialSyntheticSpec[] = [
  { seed: 402, sizeBytes: 0x6000, tableCount: 40, curvePlants: { plants: 12 } },
  { seed: 404, sizeBytes: 0x6000, tableCount: 48, curvePlants: { plants: 12 } },
];

/**
 * Committed curve-family gate fixtures (written by gen-synthetic). 301/303
 * are the Phase-1 tier-0-only fixtures — UNTOUCHED (no fallbackPlants field,
 * so their byte output is pinned identical to the original Phase-1 commit;
 * see the seed-301 regression test in synthetic.test.ts). 305/307 (Phase 1.1,
 * Task 4) add fallback-class plants (tier-5 header-low + tier-6 forward/
 * reversed adjacency) as OUT-OF-SAMPLE CI coverage for detectMs41CurveFallbacks
 * — real curve-bearing MS41 bins are gitignored, so CI never otherwise
 * exercises those paths.
 */
const CURVE_FIXTURE_SPECS: CurveSyntheticSpec[] = [
  { seed: 301, sizeBytes: 0x18000, curveCount: 24 },
  { seed: 303, sizeBytes: 0x18000, curveCount: 26 },
  { seed: 305, sizeBytes: 0x18000, curveCount: 24, fallbackPlants: { headerLow: 4, fwdAdj: 4, revAdj: 4 } },
  { seed: 307, sizeBytes: 0x18000, curveCount: 26, fallbackPlants: { headerLow: 4, fwdAdj: 4, revAdj: 4 } },
];

/** Held-out curve seeds — never committed (anti-overfitting, like seeds 3–8 / 102–106 / 202/204). */
export const HOLDOUT_CURVE_SPECS: CurveSyntheticSpec[] = [
  { seed: 302, sizeBytes: 0x18000, curveCount: 22 },
  { seed: 304, sizeBytes: 0x18000, curveCount: 28 },
  { seed: 306, sizeBytes: 0x18000, curveCount: 22, fallbackPlants: { headerLow: 4, fwdAdj: 4, revAdj: 4 } },
  { seed: 308, sizeBytes: 0x18000, curveCount: 28, fallbackPlants: { headerLow: 4, fwdAdj: 4, revAdj: 4 } },
];

export function runHoldoutCurveSeed(spec: CurveSyntheticSpec): { fixture: string } & EvalScores {
  const { bytes, truth } = generateCurveSynthetic(spec);
  const result = scan(bytes, DEFAULT_SCAN_CONFIG);
  const dataBytes = result.regions.filter((r) => r.kind === 'data').reduce((sum, r) => sum + (r.end - r.start), 0);
  return { fixture: truth.fixture, ...scoreDetections(result.potentialMaps, truth.maps, dataBytes) };
}

function runHoldout(): number {
  const rows = [
    ...HOLDOUT_SPECS.map(runHoldoutSeed),
    ...HOLDOUT_POOL_SPECS.map(runHoldoutPoolSeed),
    ...HOLDOUT_PARTIAL_SPECS.map(runHoldoutPartialSeed),
    ...HOLDOUT_CURVE_SPECS.map(runHoldoutCurveSeed),
    ...HOLDOUT_PCURVE_SPECS.map(runHoldoutPartialSeed),
  ];
  let passed = true;
  const fmt = (v: number) => v.toFixed(2);
  console.log('holdout          loc    struct axis   fp/100KB truth det');
  for (const r of rows) {
    console.log(
      `${r.fixture.padEnd(15)} ${fmt(r.locationRecall)}   ${fmt(r.structureRecall)}   ${fmt(r.axisRecall)}   ${fmt(r.falsePositiveDensity).padEnd(8)} ${String(r.truthCount).padEnd(5)} ${r.detectedCount}`
    );
    const gate = gateFor(r.fixture)!;
    if (!meetsGate(r, gate)) passed = false;
  }
  console.log(passed ? 'HOLDOUT PASS' : 'HOLDOUT FAIL (per-family gates)');
  return passed ? 0 : 1;
}

export interface FixturePair {
  bin: string;
  truth: string;
}

/**
 * A fixture = a directory under `root` holding a `<name>.bin` beside a matching
 * `<name>.groundtruth.json`. A bin without its ground-truth sibling is not a
 * fixture (it is skipped). Discovery is one level deep: each immediate
 * subdirectory of `root` is a family folder.
 */
export function discoverFixtures(root: string): FixturePair[] {
  const out: FixturePair[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.bin')) continue;
      const truth = join(dir, `${f.slice(0, -4)}.groundtruth.json`);
      try {
        statSync(truth);
        out.push({ bin: join(dir, f), truth });
      } catch {
        // bin without ground truth: not a fixture
      }
    }
  }
  return out;
}

/**
 * Resolve the repo root by walking up from `process.cwd()` until a directory
 * containing `pnpm-workspace.yaml` is found. `pnpm --filter … start` runs with
 * the package (packages/eval) as cwd, but this is robust to any cwd.
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root (pnpm-workspace.yaml) not found from cwd');
    dir = parent;
  }
}

function genSynthetic(fixturesRoot: string): void {
  const specs = [
    { seed: 1, sizeBytes: 131072, mapCount: 8 },
    { seed: 2, sizeBytes: 262144, mapCount: 20 },
  ];
  for (const spec of specs) {
    const { bytes, truth } = generateSynthetic(spec);
    const dir = join(fixturesRoot, 'synthetic');
    writeFileSync(join(dir, `synth-${spec.seed}.bin`), bytes);
    writeFileSync(join(dir, `synth-${spec.seed}.groundtruth.json`), JSON.stringify(truth, null, 2));
    console.log(`wrote synth-${spec.seed} (${spec.sizeBytes} bytes, ${spec.mapCount} maps)`);
  }
  for (const spec of POOL_FIXTURE_SPECS) {
    const { bytes, truth } = generatePoolSynthetic(spec);
    const dir = join(fixturesRoot, 'synthetic');
    writeFileSync(join(dir, `synth-pool-${spec.seed}.bin`), bytes);
    writeFileSync(join(dir, `synth-pool-${spec.seed}.groundtruth.json`), JSON.stringify(truth, null, 2));
    console.log(`wrote synth-pool-${spec.seed} (${spec.sizeBytes} bytes, ${truth.maps.length} maps)`);
  }
  for (const spec of PARTIAL_FIXTURE_SPECS) {
    const { bytes, truth } = generatePartialSynthetic(spec);
    const dir = join(fixturesRoot, 'synthetic');
    writeFileSync(join(dir, `synth-partial-${spec.seed}.bin`), bytes);
    writeFileSync(join(dir, `synth-partial-${spec.seed}.groundtruth.json`), JSON.stringify(truth, null, 2));
    console.log(`wrote synth-partial-${spec.seed} (${spec.sizeBytes} bytes, ${truth.maps.length} maps)`);
  }
  for (const spec of CURVE_FIXTURE_SPECS) {
    const { bytes, truth } = generateCurveSynthetic(spec);
    const dir = join(fixturesRoot, 'synthetic');
    writeFileSync(join(dir, `synth-curve-${spec.seed}.bin`), bytes);
    writeFileSync(join(dir, `synth-curve-${spec.seed}.groundtruth.json`), JSON.stringify(truth, null, 2));
    console.log(`wrote synth-curve-${spec.seed} (${spec.sizeBytes} bytes, ${truth.maps.length} maps)`);
  }
  for (const spec of PCURVE_FIXTURE_SPECS) {
    const { bytes, truth } = generatePartialSynthetic(spec);
    const dir = join(fixturesRoot, 'synthetic');
    writeFileSync(join(dir, `synth-pcurve-${spec.seed}.bin`), bytes);
    writeFileSync(join(dir, `synth-pcurve-${spec.seed}.groundtruth.json`), JSON.stringify(truth, null, 2));
    console.log(`wrote synth-pcurve-${spec.seed} (${spec.sizeBytes} bytes, ${truth.maps.length} maps)`);
  }
}

function runEval(repoRoot: string, fixturesRoot: string): number {
  const rows: Array<{ fixture: string } & EvalScores> = [];
  let passed = true;
  for (const { bin, truth } of discoverFixtures(fixturesRoot)) {
    const bytes = new Uint8Array(readFileSync(bin));
    const gt = parseGroundTruth(readFileSync(truth, 'utf8'));
    if (!gt.ok) {
      console.error(`SKIP ${bin}: ${gt.error}`);
      passed = false;
      continue;
    }
    const img = createBinImage(bytes, basename(bin));
    if (img.sha256 !== gt.value.binSha256) {
      console.error(`SKIP ${bin}: sha256 mismatch with ground truth`);
      passed = false;
      continue;
    }
    const result = scan(bytes, DEFAULT_SCAN_CONFIG);
    const dataBytes = result.regions
      .filter((r) => r.kind === 'data')
      .reduce((s, r) => s + (r.end - r.start), 0);
    const scores = scoreDetections(result.potentialMaps, gt.value.maps, dataBytes);
    rows.push({ fixture: gt.value.fixture, ...scores });
    const gate = gateFor(gt.value.fixture);
    if (gate && !meetsGate(scores, gate)) passed = false;
  }
  const fmt = (v: number) => v.toFixed(2);
  console.log('fixture         loc    struct axis   fp/100KB truth det');
  for (const r of rows) {
    console.log(
      `${r.fixture.padEnd(15)} ${fmt(r.locationRecall)}   ${fmt(r.structureRecall)}   ${fmt(r.axisRecall)}   ${fmt(r.falsePositiveDensity).padEnd(8)} ${String(r.truthCount).padEnd(5)} ${r.detectedCount}`
    );
  }
  writeFileSync(join(repoRoot, 'eval-report.json'), JSON.stringify({ fixtures: rows, passed }, null, 2));
  console.log(passed ? 'PASS' : 'FAIL (synth: loc ≥ 0.9, struct ≥ 0.8, axis ≥ 0.85; synth-pool: loc ≥ 0.6, struct ≥ 0.25, axis ≥ 0.9; synth-partial: loc ≥ 0.95, struct ≥ 0.95, axis ≥ 1.0; synth-curve: loc ≥ 1.0, struct ≥ 1.0, axis ≥ 1.0; synth-pcurve: loc ≥ 1.0, struct ≥ 1.0, axis ≥ 1.0; ms41: loc ≥ 0.8, struct ≥ 0.6, axis ≥ 0.5)');
  return passed ? 0 : 1;
}

const f3 = (v: number): string => v.toFixed(3);

/**
 * Score one already-scanned bin against one truth class and report the verdict.
 * Returns undefined when the ground truth could not be built (a hard error, not
 * a skip — the bin is present, so the definition should describe it).
 */
function checkAgainstClass(
  defXml: string,
  bytes: Uint8Array,
  maps: MapDef[],
  dataBytes: number,
  label: string,
  cls: '2d' | 'curve',
  applyFo: boolean,
  romId: string,
  gate: Gate
): boolean | undefined {
  const built = buildGroundTruth(defXml, createBinImage(bytes, label), {
    romId,
    fixture: label,
    idPrefix: label,
    applyFo,
    class: cls,
  });
  if (!built.ok) {
    console.error(`accept: ${label}: ${cls} ground truth failed to build: ${built.error}`);
    return undefined;
  }
  const s = scoreDetections(maps, built.value.truth.maps, dataBytes);
  const ok = meetsGate(s, gate);
  // fpD and the 1D-emission count are DIAGNOSTIC, never gated (fpD is soft on
  // real bins — they contain unlabelled true maps, so the trend matters, not
  // the value). They are reported because this command replaced the gitignored
  // controller scripts that used to print them, and partials appear in no
  // other report: `runEval` never scores one.
  const oneD = maps.filter((m) => (m.rows === 1) !== (m.cols === 1)).length;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label.padEnd(14)} ${cls === 'curve' ? 'curve' : 'grid '} ` +
      `${f3(s.locationRecall)}/${f3(s.structureRecall)}/${f3(s.axisRecall)}` +
      `  gate ${f3(gate.locationRecall)}/${f3(gate.structureRecall)}/${f3(gate.axisRecall)}` +
      `  (truth ${s.truthCount}, det ${s.detectedCount}, 1d ${oneD}, fpD ${s.falsePositiveDensity.toFixed(2)})`
  );
  return ok;
}

/** Scan a bin once and return the emissions plus its data-region size. */
function scanForAcceptance(bytes: Uint8Array): { maps: MapDef[]; dataBytes: number } {
  const result = scan(bytes, DEFAULT_SCAN_CONFIG);
  return {
    maps: result.potentialMaps,
    dataBytes: result.regions.filter((r) => r.kind === 'data').reduce((s, r) => s + (r.end - r.start), 0),
  };
}

/**
 * Real-bin acceptance (`pnpm eval accept`) — the gates that bind only where
 * the gitignored firmware exists.
 *
 * Covers two surfaces that `runEval` cannot:
 *  - FULL READS, 1D-curve class (MS41_CURVE_GATE). The `ms41-*` fixture rows
 *    already score against the committed 2-axis GRID truth via MS41_GATE, so
 *    only the curve class is missing there.
 *  - PARTIALS, both grid and curve classes (MS41_PARTIAL_GATE). No partial
 *    carries a committed groundtruth.json, so `runEval` never scores one at
 *    all and NEITHER class is otherwise guarded.
 *
 * WHY A SEPARATE COMMAND, not `gateFor` entries: curve truth and grid truth
 * are mutually exclusive classes, so folding curve scores into the existing
 * `ms41-*` rows would silently change what those published numbers mean.
 *
 * WHY IT EXISTS AT ALL: MS41_CURVE_GATE had zero consumers and the partial
 * floors existed only as prose. The real-bin numbers behind five shipped
 * phases were verified by a human reading `console.log` output from gitignored
 * scripts, so a regression passed every automated check in the repository.
 *
 * CI-SAFE BY CONSTRUCTION: firmware and the source definition are gitignored,
 * so every case is absent on CI and the command reports skips and exits 0 —
 * the same posture MS41_GATE already takes. Exit 1 means a gate was genuinely
 * missed; exit 0 with skips means there was nothing local to check.
 */
export function runAcceptance(repoRoot: string): number {
  let defXml: string;
  try {
    defXml = readFileSync(join(repoRoot, MS41_ACCEPTANCE_DEF), 'utf8');
  } catch {
    console.log(`accept: no local definition at ${MS41_ACCEPTANCE_DEF} — nothing to check (skipped)`);
    return 0;
  }
  let passed = true;
  let checked = 0;
  const skipped: string[] = [];
  const record = (v: boolean | undefined): void => {
    if (v === undefined) passed = false;
    else {
      checked++;
      if (!v) passed = false;
    }
  };

  // Full reads — curve class only (grid is covered by MS41_GATE in runEval).
  for (const c of MS41_ACCEPTANCE_CASES) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(repoRoot, 'fixtures', 'ms41', c.bin)));
    } catch {
      skipped.push(`${c.key} (full)`);
      continue;
    }
    const { maps, dataBytes } = scanForAcceptance(bytes);
    record(checkAgainstClass(defXml, bytes, maps, dataBytes, c.key, 'curve', true, c.romId, c.gate));
  }

  // Partials — BOTH classes, applyFo false (a direct-SA storageaddress already
  // IS the file offset). One scan per bin, scored twice.
  for (const c of MS41_PARTIAL_ACCEPTANCE_CASES) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(repoRoot, 'fixtures', 'ms41', 'partial', c.bin)));
    } catch {
      skipped.push(`${c.key} (partial)`);
      continue;
    }
    const label = `${c.key}-partial`;
    const { maps, dataBytes } = scanForAcceptance(bytes);
    record(checkAgainstClass(defXml, bytes, maps, dataBytes, label, '2d', false, c.romId, c.gridGate));
    record(checkAgainstClass(defXml, bytes, maps, dataBytes, label, 'curve', false, c.romId, c.curveGate));
  }

  if (skipped.length > 0) console.log(`accept: skipped (no local bin): ${skipped.join(', ')}`);
  if (checked === 0) {
    console.log('accept: no local real-bin fixtures — nothing to check (skipped)');
    return passed ? 0 : 1;
  }
  console.log(passed ? `ACCEPT PASS (${checked} checked)` : `ACCEPT FAIL (${checked} checked)`);
  return passed ? 0 : 1;
}

export function runGtFromRomraider(argv: string[]): number {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--fo') flags.set('fo', true);
    else if (a.startsWith('--')) flags.set(a.slice(2), argv[++i] ?? '');
    else positional.push(a);
  }
  const [defPath, binPath] = positional;
  const fixture = flags.get('fixture');
  const idPrefix = flags.get('id-prefix');
  if (defPath === undefined || binPath === undefined || typeof fixture !== 'string' || typeof idPrefix !== 'string') {
    console.error(
      'usage: pnpm eval gt-from-romraider <def.xml> <bin> --fixture <name> --id-prefix <prefix> [--rom <xmlid>] [--fo] [--out <path>]\n' +
        '(relative paths resolve against the repo root — `pnpm eval` runs with packages/eval as cwd)'
    );
    return 2;
  }
  // `pnpm --filter … start` runs with packages/eval as cwd (see findRepoRoot's
  // JSDoc) — resolve every user-supplied path against the repo root so the
  // documented repo-root-relative invocations work; resolve() passes absolute
  // paths through untouched.
  const root = findRepoRoot();
  const defAbs = resolve(root, defPath);
  const binAbs = resolve(root, binPath);
  let defXml: string;
  let binBytes: Uint8Array;
  try {
    defXml = readFileSync(defAbs, 'utf8');
    binBytes = new Uint8Array(readFileSync(binAbs));
  } catch (e) {
    console.error(`gt-from-romraider: cannot read input: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const bin = createBinImage(binBytes, basename(binAbs));
  const opts: GtBuildOptions = { fixture, idPrefix, applyFo: flags.get('fo') === true };
  const rom = flags.get('rom');
  if (typeof rom === 'string') opts.romId = rom;
  const built = buildGroundTruth(defXml, bin, opts);
  if (!built.ok) {
    console.error(`gt-from-romraider: ${built.error}`);
    return 1;
  }
  for (const w of built.value.warnings) console.error(`warning: ${w}`);
  const outFlag = flags.get('out');
  const out = typeof outFlag === 'string' ? resolve(root, outFlag) : `${binAbs.replace(/\.bin$/i, '')}.groundtruth.json`;
  writeFileSync(out, JSON.stringify(built.value.truth, null, 2));
  console.log(`wrote ${out}: ${built.value.truth.maps.length} truth maps (bin sha ${bin.sha256.slice(0, 12)}…)`);
  return 0;
}

/**
 * True when this module is the process entry point (invoked as a script), not
 * merely imported (e.g. by the discoverFixtures unit test). Guards the side
 * effects — repo-root resolution and process.exit — from running on import.
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}

if (isMain()) {
  const cmd = process.argv[2];
  const repoRoot = findRepoRoot();
  const fixturesRoot = join(repoRoot, 'fixtures');
  if (cmd === 'gen-synthetic') genSynthetic(fixturesRoot);
  else if (cmd === 'holdout') process.exit(runHoldout());
  else if (cmd === 'accept') process.exit(runAcceptance(repoRoot));
  else if (cmd === 'gt-from-romraider') process.exit(runGtFromRomraider(process.argv.slice(3)));
  else process.exit(runEval(repoRoot, fixturesRoot));
}
