import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  generateSynthetic,
  generatePoolSynthetic,
  generatePartialSynthetic,
  generateCurveSynthetic,
  type PartialSyntheticSpec,
} from '../src/synthetic.js';
import { createBinImage, validateMapDef } from '@binanalyzer/core';
import {
  DEFAULT_SCAN_CONFIG,
  classifyRegions,
  scanPrefixedAxes,
  poolStructuralActive,
  poolStructuralHeaderCount,
  scan,
  scanReaderCalls,
  selfLocateCurveReaders,
  detectMs41Curves,
  detectMs41CurveFallbacks,
  CURVE_FALLBACK_TIER,
  CURVE_ADJ_TIER,
  headlessCurveDetections,
} from '@binanalyzer/engine';
import { scoreDetections } from '../src/metrics.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('generateSynthetic', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a1 = generateSynthetic({ seed: 1, sizeBytes: 65536, mapCount: 4 });
    const a2 = generateSynthetic({ seed: 1, sizeBytes: 65536, mapCount: 4 });
    const b = generateSynthetic({ seed: 2, sizeBytes: 65536, mapCount: 4 });
    expect(a1.bytes).toEqual(a2.bytes);
    expect(a1.truth).toEqual(a2.truth);
    expect(a1.bytes).not.toEqual(b.bytes);
  });
  it('plants mapCount valid maps with referenced axes and correct sha', () => {
    const { bytes, truth } = generateSynthetic({ seed: 3, sizeBytes: 131072, mapCount: 8 });
    expect(truth.maps).toHaveLength(8);
    expect(truth.binSha256).toBe(createBinImage(bytes, 'x').sha256);
    for (const m of truth.maps) {
      expect(validateMapDef(m, bytes.length).ok).toBe(true);
      expect(m.xAxis?.kind).toBe('referenced');
      expect(m.yAxis?.kind).toBe('referenced');
    }
  });
});

describe('generatePoolSynthetic', () => {
  const spec = { seed: 101, sizeBytes: 196608, groupCount: 7 };

  it('is seed-deterministic (same seed → identical bytes and truth)', () => {
    const a = generatePoolSynthetic(spec);
    const b = generatePoolSynthetic(spec);
    expect(a.truth.binSha256).toBe(b.truth.binSha256);
    expect(a.truth.maps).toEqual(b.truth.maps);
    expect(a.truth.fixture).toBe('synth-pool-101');
  });

  it('produces validateMapDef-clean maps with referenced pool axes', () => {
    const { bytes, truth } = generatePoolSynthetic(spec);
    expect(truth.maps.length).toBeGreaterThanOrEqual(15);
    for (const m of truth.maps) {
      const r = validateMapDef(m, bytes.length);
      expect(r.ok, `${m.id}: ${r.ok ? '' : r.error}`).toBe(true);
      expect(m.xAxis?.kind).toBe('referenced');
      expect(m.yAxis?.kind).toBe('referenced');
      // shared-pool layout: axes precede the table at a distance
      expect(m.xAxis!.address!).toBeLessThan(m.address);
      expect(m.yAxis!.address!).toBeLessThan(m.address);
    }
  });

  it('plants count prefixes before every axis', () => {
    const { bytes, truth } = generatePoolSynthetic(spec);
    for (const m of truth.maps) {
      for (const a of [m.xAxis!, m.yAxis!]) {
        const w = a.format!.width;
        if (w === 1) expect(bytes[a.address! - 1]).toBe(a.count);
        else expect(bytes[a.address! - 2]! | (bytes[a.address! - 1]! << 8)).toBe(a.count);
      }
    }
  });
});

describe('generatePartialSynthetic', () => {
  const spec = { seed: 201, sizeBytes: 0x6000, tableCount: 44 };

  it('is seed-deterministic (same seed → identical bytes and truth)', () => {
    const a = generatePartialSynthetic(spec);
    const b = generatePartialSynthetic(spec);
    expect(a.bytes).toEqual(b.bytes);
    expect(a.truth).toEqual(b.truth);
    expect(a.truth.fixture).toBe('synth-partial-201');
  });

  it('differs across seeds', () => {
    const a = generatePartialSynthetic(spec);
    const c = generatePartialSynthetic({ ...spec, seed: 203 });
    expect(a.bytes).not.toEqual(c.bytes);
  });

  it('produces validateMapDef-clean maps with referenced axes carrying a format', () => {
    const { bytes, truth } = generatePartialSynthetic(spec);
    expect(truth.maps.length).toBeGreaterThan(0);
    expect(truth.binSha256).toBe(createBinImage(bytes, 'x').sha256);
    for (const m of truth.maps) {
      const r = validateMapDef(m, bytes.length);
      expect(r.ok, `${m.id}: ${r.ok ? '' : r.error}`).toBe(true);
      expect(m.xAxis?.kind).toBe('referenced');
      expect(m.yAxis?.kind).toBe('referenced');
      expect(m.xAxis?.format).toBeDefined();
      expect(m.yAxis?.format).toBeDefined();
    }
  });

  it('activates the partial-structural detector (header-dense direct-SA gate lift)', () => {
    const { bytes } = generatePartialSynthetic(spec);
    const cfg = DEFAULT_SCAN_CONFIG;
    const regions = classifyRegions(bytes, cfg);
    const prefixed = scanPrefixedAxes(bytes, regions, cfg);
    expect(poolStructuralHeaderCount(bytes, cfg)).toBeGreaterThanOrEqual(cfg.pool.structHeaderGateMin);
    expect(poolStructuralActive(bytes, prefixed, cfg)).toBe(true);
  });

  it('seed 201 (exact committed spec, knob off) is byte-identical to the committed fixture', () => {
    // Pins old-path byte-identity in CI forever: if the Phase-3 curvePlants
    // wiring ever perturbs the base LCG stream or byte writes, this fails
    // (the seed-301 P1.1 precedent).
    const committed = generatePartialSynthetic({ seed: 201, sizeBytes: 0x6000, tableCount: 44 });
    const onDisk = new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'synthetic', 'synth-partial-201.bin')));
    expect(committed.bytes).toEqual(onDisk);
  });
});

describe('generatePartialSynthetic — curvePlants (Phase 3 synth-pcurve family)', () => {
  const cfg = DEFAULT_SCAN_CONFIG;
  const pcSpec = { seed: 401, sizeBytes: 0x6000, tableCount: 44, curvePlants: { plants: 12 } };

  it('is seed-deterministic and the knob changes bytes only when set', () => {
    const a = generatePartialSynthetic(pcSpec);
    const b = generatePartialSynthetic(pcSpec);
    expect(a.bytes).toEqual(b.bytes);
    expect(a.truth).toEqual(b.truth);
    const off = generatePartialSynthetic({ seed: 401, sizeBytes: 0x6000, tableCount: 44 });
    expect(a.bytes).not.toEqual(off.bytes);
  });

  it('truth = the planted curves only (N×1 w1, referenced yAxis), fixture synth-pcurve-<seed>', () => {
    const { bytes, truth } = generatePartialSynthetic(pcSpec);
    expect(truth.fixture).toBe('synth-pcurve-401');
    expect(truth.binSha256).toBe(createBinImage(bytes, 'x').sha256);
    // 12 plants cycling pool-abut / pad-chain-pair / adjax = 4 + 4×2 + 4 = 16 curves
    expect(truth.maps).toHaveLength(16);
    for (const m of truth.maps) {
      const r = validateMapDef(m, bytes.length);
      expect(r.ok, `${m.id}: ${r.ok ? '' : r.error}`).toBe(true);
      expect(m.cols).toBe(1);
      expect(m.rows).toBeGreaterThanOrEqual(2);
      expect(m.format.width).toBe(1);
      expect(m.xAxis).toBeUndefined();
      expect(m.yAxis?.kind).toBe('referenced');
      expect(m.yAxis?.format).toBeDefined();
      // count prefix sits immediately before the u8 axis data
      expect(bytes[m.yAxis!.address! - 1]).toBe(m.yAxis!.count);
    }
    // the plant mix includes an odd-length pad case (odd row count present)
    expect(truth.maps.some((m) => m.rows % 2 === 1)).toBe(true);
    // ...and an adjax case (count-3 axis, below the pool scanner's minCount)
    expect(truth.maps.some((m) => m.rows === 3)).toBe(true);
  });

  it('stays gate-active and scan() emits every planted curve as N×1', { timeout: 60_000 }, () => {
    const { bytes, truth } = generatePartialSynthetic(pcSpec);
    const regions = classifyRegions(bytes, cfg);
    const prefixed = scanPrefixedAxes(bytes, regions, cfg);
    expect(poolStructuralActive(bytes, prefixed, cfg)).toBe(true);
    const maps = scan(bytes, cfg).potentialMaps;
    for (const t of truth.maps) {
      const hit = maps.find((m) => m.address === t.address && m.cols === 1 && m.rows === t.rows);
      expect(hit, `planted curve @0x${t.address.toString(16)} n=${t.rows} not emitted`).toBeDefined();
    }
  });

  it('throws when curve plants would write past sizeBytes (never silently truncates)', () => {
    // Uint8Array OOB writes are silent no-ops — without an explicit guard a
    // too-small sizeBytes would yield truncated plants whose ground truth
    // points at bytes that were never written (review hygiene item).
    expect(() =>
      generatePartialSynthetic({ seed: 401, sizeBytes: 0x6000, tableCount: 44, curvePlants: { plants: 1000 } })
    ).toThrow(/sizeBytes too small for curvePlants/);
  });

  it('pool-ACTIVE non-MS41 negative control: a curveless gate-active partial emits ZERO curve-shaped maps', { timeout: 60_000 }, () => {
    // seed 202 (holdout partial, knob off): poolStructuralActive is TRUE and
    // the discriminator measured zero passes — the gate-safety skeptic's ask.
    const { bytes } = generatePartialSynthetic({ seed: 202, sizeBytes: 0x6000, tableCount: 40 });
    const regions = classifyRegions(bytes, cfg);
    const prefixed = scanPrefixedAxes(bytes, regions, cfg);
    expect(poolStructuralActive(bytes, prefixed, cfg)).toBe(true);
    const maps = scan(bytes, cfg).potentialMaps;
    expect(maps.filter((m) => (m.rows === 1) !== (m.cols === 1))).toHaveLength(0);
  });
});

describe('generateCurveSynthetic', () => {
  const spec = { seed: 301, sizeBytes: 0x18000, curveCount: 24 };

  it('places each synthetic reader at the flash address selected by its CPU call target', () => {
    const { bytes } = generateCurveSynthetic(spec);
    const calls = scanReaderCalls(bytes, DEFAULT_SCAN_CONFIG.family.ms41.maxR12Dist);
    const targets = [...new Set(calls.map(c => c.targetCpu))];
    expect(targets).toHaveLength(4);
    for (const cpu of targets) {
      expect([0xa8, 0xa9]).toContain(bytes[cpu ^ 0x4000]);
      expect(bytes[(cpu ^ 0x4000) + 1]).toBe(0x24);
    }
  });

  it('is seed-deterministic (same seed -> identical bytes and truth) and differs across seeds', () => {
    const a = generateCurveSynthetic(spec);
    const b = generateCurveSynthetic(spec);
    expect(a.bytes).toEqual(b.bytes);
    expect(a.truth).toEqual(b.truth);
    expect(a.truth.fixture).toBe('synth-curve-301');
    const c = generateCurveSynthetic({ ...spec, seed: 303 });
    expect(a.bytes).not.toEqual(c.bytes);
  });

  it('plants curveCount 1D (N x 1) curves with validateMapDef-clean truth and correct sha', () => {
    const { bytes, truth } = generateCurveSynthetic(spec);
    expect(truth.maps).toHaveLength(24);
    expect(truth.binSha256).toBe(createBinImage(bytes, 'x').sha256);
    for (const m of truth.maps) {
      expect(m.cols).toBe(1);
      expect(m.rows).toBeGreaterThanOrEqual(4);
      expect(m.xAxis).toBeUndefined();
      expect(m.yAxis?.kind).toBe('referenced');
      expect(m.yAxis?.count).toBe(m.rows);
      const r = validateMapDef(m, bytes.length);
      expect(r.ok, `${m.id}: ${r.ok ? '' : r.error}`).toBe(true);
    }
    // both reader widths (w1 byte, w2 LE word) are exercised
    expect(truth.maps.some((m) => m.format.width === 1)).toBe(true);
    expect(truth.maps.some((m) => m.format.width === 2 && m.format.endianness === 'little')).toBe(true);
  });

  it(
    'clears the family activation gate + curveActivateMin and scan() recovers most planted curves',
    { timeout: 30_000 },
    () => {
      const { bytes, truth } = generateCurveSynthetic(spec);
      const result = scan(bytes, DEFAULT_SCAN_CONFIG);
      const oneD = result.potentialMaps.filter((m) => m.cols === 1 && m.rows > 1);
      expect(oneD.length).toBeGreaterThan(0); // the curve tier actually activated and fired
      const dataBytes = result.regions.filter((r) => r.kind === 'data').reduce((s, r) => s + (r.end - r.start), 0);
      const scores = scoreDetections(result.potentialMaps, truth.maps, dataBytes);
      expect(scores.locationRecall).toBeGreaterThanOrEqual(0.9);
      expect(scores.structureRecall).toBeGreaterThanOrEqual(0.9);
    }
  );

  it(
    'sub-activation negative control: LOCATABLE curve readers below curveActivateMin yield ZERO curve-shaped detections',
    { timeout: 30_000 },
    () => {
      // curveCount 16 isolates the curveActivateMin floor: curves alternate
      // w1/w2 across the two curve-reader targets, so each target gets 8
      // distinct header-backed args (>= curveReaderMinArgs 5, rate 100% >=
      // curveReaderHeaderRateMin) — BOTH curve readers self-locate, proven
      // below. Yet total curve-reader CALL sites (one per curve) is 16 <
      // curveActivateMin 20, so the activation floor is the ONLY gate
      // between the located readers and emission: delete the
      // `curveArgs >= curveActivateMin` check in analyzer.ts and this test
      // fails. (A smaller count, e.g. 6 -> 3 args/target, would be excluded
      // by curveReaderMinArgs instead and never exercise the floor.)
      const { bytes } = generateCurveSynthetic({ seed: 301, sizeBytes: 0x18000, curveCount: 16 });
      const calls = scanReaderCalls(bytes, DEFAULT_SCAN_CONFIG.family.ms41.maxR12Dist);
      const curveReaders = selfLocateCurveReaders(bytes, calls, DEFAULT_SCAN_CONFIG);
      expect(curveReaders.size).toBe(2); // both curve readers located — the confound is gone
      const curveArgs = calls.filter((c) => curveReaders.has(c.targetCpu)).length;
      expect(curveArgs).toBe(16);
      expect(curveArgs).toBeLessThan(DEFAULT_SCAN_CONFIG.family.ms41.curveActivateMin);
      const result = scan(bytes, DEFAULT_SCAN_CONFIG);
      const oneD = result.potentialMaps.filter((m) => (m.rows === 1) !== (m.cols === 1));
      expect(oneD).toEqual([]);
    }
  );

  it('generateCurveSynthetic seed 301 (exact committed spec) is byte-identical to the committed fixture', () => {
    // Pins old-path byte-identity in CI forever: if fallbackPlants wiring
    // ever perturbs the LCG stream consumed by the pre-existing curveCount
    // loop, this goes red — not just at gen-synthetic time, on every test run.
    const committed = generateCurveSynthetic({ seed: 301, sizeBytes: 0x18000, curveCount: 24 });
    const onDisk = new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'synthetic', 'synth-curve-301.bin')));
    expect(committed.bytes).toEqual(onDisk);
  });

  describe('fallback-class plants (Phase 1.1)', () => {
    const fbSpec = {
      seed: 3051,
      sizeBytes: 0x18000,
      curveCount: 24,
      fallbackPlants: { headerLow: 4, fwdAdj: 4, revAdj: 4 },
    };

    it('is seed-deterministic with the knob on, and differs from the knob-off output for the SAME seed', () => {
      const a = generateCurveSynthetic(fbSpec);
      const b = generateCurveSynthetic(fbSpec);
      expect(a.bytes).toEqual(b.bytes);
      expect(a.truth).toEqual(b.truth);
      const off = generateCurveSynthetic({ seed: fbSpec.seed, sizeBytes: fbSpec.sizeBytes, curveCount: fbSpec.curveCount });
      expect(a.bytes).not.toEqual(off.bytes);
      expect(a.truth.maps.length).toBe(off.truth.maps.length + 12); // 4 + 4 + 4 fallback plants
    });

    it('plants headerLow + fwdAdj + revAdj curves with the same GroundTruth shape as tier-0 curves', () => {
      const { bytes, truth } = generateCurveSynthetic(fbSpec);
      expect(truth.maps).toHaveLength(24 + 12);
      for (const m of truth.maps) {
        expect(m.cols).toBe(1);
        expect(m.xAxis).toBeUndefined();
        expect(m.yAxis?.kind).toBe('referenced');
        expect(m.yAxis?.count).toBe(m.rows);
        const r = validateMapDef(m, bytes.length);
        expect(r.ok, `${m.id}: ${r.ok ? '' : r.error}`).toBe(true);
      }
      // headerLow: count-2/3 curves BELOW the tier-0 floor (curveAxisMinCount 4)
      expect(truth.maps.filter((m) => m.rows === 2)).not.toHaveLength(0);
      expect(truth.maps.filter((m) => m.rows === 3)).not.toHaveLength(0);
      // fwdAdj: both u8 and u16 axis-prefix widths exercised
      expect(truth.maps.some((m) => m.yAxis?.format?.width === 1)).toBe(true);
      expect(truth.maps.some((m) => m.yAxis?.format?.width === 2)).toBe(true);
    });

    it('exercises tier-5 (headerLow) and tier-6 (fwdAdj/revAdj) exactly: detectMs41Curves misses all 12, detectMs41CurveFallbacks recovers all 12 at the right tiers', () => {
      const { bytes } = generateCurveSynthetic(fbSpec);
      const calls = scanReaderCalls(bytes, DEFAULT_SCAN_CONFIG.family.ms41.maxR12Dist);
      const curveReaders = selfLocateCurveReaders(bytes, calls, DEFAULT_SCAN_CONFIG);
      expect(curveReaders.size).toBe(2);
      const tier0 = detectMs41Curves(bytes, calls, curveReaders, DEFAULT_SCAN_CONFIG);
      expect(tier0).toHaveLength(24); // only the main curveCount loop's curves
      const fallbacks = detectMs41CurveFallbacks(bytes, calls, curveReaders, DEFAULT_SCAN_CONFIG);
      expect(fallbacks).toHaveLength(12);
      const byTier = new Map<number, number>();
      for (const f of fallbacks) byTier.set(f.tier, (byTier.get(f.tier) ?? 0) + 1);
      expect(byTier.get(CURVE_FALLBACK_TIER)).toBe(4); // headerLow
      expect(byTier.get(CURVE_ADJ_TIER)).toBe(8); // fwdAdj + revAdj
    });

    it(
      'scan() recovers ALL planted curves (tier-0 + fallback tiers) at loc/struct 1.0',
      { timeout: 30_000 },
      () => {
        const { bytes, truth } = generateCurveSynthetic(fbSpec);
        const result = scan(bytes, DEFAULT_SCAN_CONFIG);
        const dataBytes = result.regions.filter((r) => r.kind === 'data').reduce((s, r) => s + (r.end - r.start), 0);
        const scores = scoreDetections(result.potentialMaps, truth.maps, dataBytes);
        expect(scores.locationRecall).toBe(1);
        expect(scores.structureRecall).toBe(1);
      }
    );
  });
});

describe('P3.1-S1 headerless overlay — holdout inertness (spike-measured ZERO + 96-config negctl)', () => {
  const cfg = DEFAULT_SCAN_CONFIG;
  const specs = [
    { seed: 202, sizeBytes: 0x6000, tableCount: 40 },
    { seed: 204, sizeBytes: 0x6000, tableCount: 48 },
    { seed: 402, sizeBytes: 0x6000, tableCount: 40, curvePlants: { plants: 12 } },
    { seed: 404, sizeBytes: 0x6000, tableCount: 48, curvePlants: { plants: 12 } },
  ];
  for (const spec of specs) {
    it(`holdout seed ${spec.seed}: ZERO headerless detections`, { timeout: 60_000 }, () => {
      const { bytes } = generatePartialSynthetic(spec as PartialSyntheticSpec);
      const maps = scan(bytes, cfg).potentialMaps;
      const prefixed = scanPrefixedAxes(bytes, classifyRegions(bytes, cfg), cfg);
      expect(headlessCurveDetections(bytes, maps, prefixed, cfg)).toHaveLength(0);
    });
  }
});
