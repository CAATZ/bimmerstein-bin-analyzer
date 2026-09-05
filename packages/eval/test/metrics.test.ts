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
  it('requires the complete layout and both axis roles for strict accuracy', () => {
    const table = mk(1000, 4, 4, {
      xAxis: { kind: 'referenced', address: 900, count: 4, format: u16be },
      yAxis: { kind: 'referenced', address: 920, count: 4, format: u16be },
    });
    expect(scoreDetections([table], [table], 102400)).toMatchObject({ exactLayoutRecall: 1, axisPairRecall: 1 });
    for (const extra of [
      { xAxis: table.yAxis!, yAxis: table.xAxis! },
      { yAxis: { ...table.yAxis!, address: 940 } },
      { xAxis: { ...table.xAxis!, count: 3 } },
      { xAxis: { ...table.xAxis!, format: { ...u16be, endianness: 'little' as const } } },
    ]) {
      const scores = scoreDetections([{ ...table, ...extra }], [table], 102400);
      expect(scores.axisRecall).toBe(1);
      expect(scores.axisPairRecall).toBe(0);
    }
    for (const extra of [
      { address: 1001 }, { rows: 2, cols: 8 }, { orientation: 'col-major' as const },
      { format: { ...u16be, signed: true } }, { format: { ...u16be, endianness: 'little' as const } },
      { format: { ...u16be, width: 4 as const, float: true } },
    ]) {
      expect(scoreDetections([{ ...table, ...extra }], [table], 102400)).toMatchObject({ exactLayoutRecall: 0, axisPairRecall: 0 });
    }
    expect(scoreDetections([table], [table, { ...table, address: 2000 }], 102400).axisPairRecall).toBe(0.5);
  });

  it('compares literal axis values and ignores irrelevant one-byte endianness', () => {
    const table = mk(1000, 1, 4, {
      format: { width: 1, signed: false, endianness: 'little' },
      xAxis: { kind: 'literal', count: 4, values: [1, 2, 3, 4] },
    });
    const detected = { ...table, format: { ...table.format, endianness: 'big' as const } };
    expect(scoreDetections([detected], [table], 102400)).toMatchObject({ exactLayoutRecall: 1, axisPairRecall: 1 });
    expect(scoreDetections([{ ...detected, xAxis: { ...table.xAxis!, values: [1, 2, 4, 5] } }], [table], 102400).axisPairRecall).toBe(0);
    expect(scoreDetections([], [], 102400)).toMatchObject({ exactLayoutRecall: 0, axisPairRecall: 0 });
  });

  it('reports exact starts separately from overlapping location hits', () => {
    const truth = [mk(1000, 6, 8), mk(2000, 6, 8), mk(3000, 6, 8)];
    const shifted = scoreDetections([mk(1001, 6, 8), mk(1998, 6, 8), mk(3000, 6, 8)], truth, 102400);
    expect(shifted.locationRecall).toBe(1);
    expect(shifted.structureRecall).toBe(1);
    expect(shifted.exactStartRecall).toBe(1 / 3);
    expect(scoreDetections([], truth, 102400).exactStartRecall).toBe(0);
    expect(scoreDetections([], [], 102400).exactStartRecall).toBe(0);
  });

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
      locationRecall: 1, exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1, structureRecall: 1, axisRecall: 1,
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
