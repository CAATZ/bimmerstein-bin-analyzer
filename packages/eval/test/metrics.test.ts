import { describe, expect, it } from 'vitest';
import { scoreDetections } from '../src/metrics.js';
import type { MapDef, ValueFormat } from '@binanalyzer/core';

const u16be: ValueFormat = { width: 2, signed: false, endianness: 'big' };
const mk = (address: number, rows: number, cols: number, extra: Partial<MapDef> = {}): MapDef => ({
  id: `m${address}`, name: 'm', address, rows, cols, format: u16be,
  scaling: { factor: 1, offset: 0, units: '', digits: 0 }, orientation: 'row-major',
  provenance: 'imported', ...extra,
});

describe('scoreDetections', () => {
  const truth = [
    mk(1000, 6, 8, { xAxis: { kind: 'referenced', count: 8, address: 960, format: u16be } }),
    mk(5000, 4, 4),
  ];
  it('perfect detection scores 1/1/1 with 0 FP', () => {
    const detected = [
      mk(1000, 6, 8, { provenance: 'auto', confidence: 0.9, xAxis: { kind: 'referenced', count: 8, address: 960, format: u16be } }),
      mk(5000, 4, 4, { provenance: 'auto', confidence: 0.8 }),
    ];
    const s = scoreDetections(detected, truth, 102400);
    expect(s).toEqual({
      locationRecall: 1, structureRecall: 1, axisRecall: 1,
      falsePositiveDensity: 0, truthCount: 2, detectedCount: 2,
    });
  });
  it('transposed dims count for structure; wrong dims only for location', () => {
    const detected = [mk(1000, 8, 6, { provenance: 'auto', confidence: 0.9 })]; // transposed, overlaps fully
    const s = scoreDetections(detected, truth, 102400);
    expect(s.locationRecall).toBe(0.5);
    expect(s.structureRecall).toBe(0.5);
    expect(s.axisRecall).toBe(0);
  });
  it('non-overlapping detections are false positives', () => {
    const detected = [mk(90000, 4, 4, { provenance: 'auto', confidence: 0.9 })];
    const s = scoreDetections(detected, truth, 204800);
    expect(s.locationRecall).toBe(0);
    expect(s.falsePositiveDensity).toBe(0.5); // 1 FP per 200KB = 0.5 per 100KB
  });
  it('empty truth → zero recalls, no NaN', () => {
    const s = scoreDetections([], [], 102400);
    expect(s.locationRecall).toBe(0);
    expect(Number.isNaN(s.structureRecall)).toBe(false);
  });
});
