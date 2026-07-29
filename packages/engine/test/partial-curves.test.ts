import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MapDef, ValueFormat } from '@binanalyzer/core';
import { partialCurveDetections } from '../src/partial-curves.js';
import { classifyRegions } from '../src/regions.js';
import { scanPrefixedAxes, type PrefixedAxis } from '../src/pool.js';
import { scan } from '../src/index.js';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';

/**
 * Phase-3 trusted-structure tiling discriminator (spike
 * docs/notes/ms41-p3-partial-curves-spike.md, FINAL R8 stack of
 * scratch/spike-p3-ladder2.ts). One crafted buffer per component.
 */

const cfg = DEFAULT_SCAN_CONFIG;
const u8: ValueFormat = { width: 1, signed: false, endianness: 'big' };

/** [n][cells...] strictly-increasing u8 axis at `prefix`; returns data address. */
function putAxis(b: Uint8Array, prefix: number, count: number, start = 10, step = 11): number {
  b[prefix] = count;
  for (let i = 0; i < count; i++) b[prefix + 1 + i] = start + i * step;
  return prefix + 1;
}
/** 2-byte LE backward header at `p-2` pointing at `ptr`, data bytes after it. */
function putCurve(b: Uint8Array, s: number, ptr: number, count: number, fill = 200): number {
  b[s] = ptr & 0xff;
  b[s + 1] = (ptr >> 8) & 0xff;
  for (let i = 0; i < count; i++) b[s + 2 + i] = fill + (i % 3); // non-monotone junk-ish data (no smoothness needed)
  return s + 2; // p
}
const pax = (address: number, count: number): PrefixedAxis => ({
  address, count, format: u8, end: address + count * u8.width, maximal: true,
});
/** Minimal structural-grid MapDef (detector 'structural') with referenced axes. */
function gridMap(address: number, rows: number, cols: number, xData: number, yData: number): MapDef {
  return {
    id: `t-0x${address.toString(16)}`,
    name: 'grid',
    address, rows, cols, format: u8,
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major',
    provenance: 'auto',
    detector: 'structural',
    xAxis: { kind: 'referenced', address: xData, count: cols, format: u8 },
    yAxis: { kind: 'referenced', address: yData, count: rows, format: u8 },
  };
}

describe('partialCurveDetections — component tests', () => {
  it('(a) happy path: trusted grid + pooled axis + curve block abutting a known edge → one detection with exact count', () => {
    const b = new Uint8Array(0x400);
    // legit grid at 0x300 (4x4): header at 0x2FC -> axes 0x200/0x210, large data bytes
    putAxis(b, 0x200, 4, 30, 40);
    putAxis(b, 0x210, 4, 35, 45);
    b[0x2fc] = 0x00; b[0x2fd] = 0x02; // xPtr 0x200
    b[0x2fe] = 0x10; b[0x2ff] = 0x02; // yPtr 0x210
    for (let i = 0; i < 16; i++) b[0x300 + i] = 210 + (i % 4);
    // pooled axis at 0x100 (count 6) — its span [0x100, 0x107) supplies the trusted edge
    const aData = putAxis(b, 0x100, 6);
    // curve: starts exactly at the pool span's end edge 0x107, ptr -> the pooled axis prefix
    const p = putCurve(b, 0x107, 0x100, 6);
    const maps = [gridMap(0x300, 4, 4, 0x201, 0x211)];
    const out = partialCurveDetections(b, maps, [pax(aData, 6)], cfg);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      address: p, rows: 6, cols: 1, tier: 7, kind: '1d',
      score: cfg.pool.curvePartialConfidence,
      yAxis: { address: aData, count: 6 },
    });
    expect(out[0]!.format.width).toBe(1);
  });

  it('(b) F-glegit: a grid without a re-validating header is demoted and stops vetoing; a dims-matching header keeps vetoing', () => {
    const build = (legitHeader: boolean): { b: Uint8Array; maps: MapDef[]; prefixed: PrefixedAxis[]; p: number } => {
      const b = new Uint8Array(0x400);
      // the candidate's own axis (count 4) far below
      putAxis(b, 0x100, 4);
      // grid emission at 0x300 (4x4, u8) whose span is [0x2FC, 0x310)
      putAxis(b, 0x200, 4, 30, 40);
      putAxis(b, 0x210, 4, 35, 45);
      if (legitHeader) {
        b[0x2fc] = 0x00; b[0x2fd] = 0x02;
        b[0x2fe] = 0x10; b[0x2ff] = 0x02;
      } // else: zeros at 0x2FC-0x2FF → gridLegit fails → demoted
      for (let i = 0; i < 16; i++) b[0x300 + i] = 210 + (i % 4); // large bytes: no incidental candidates
      // curve block [0x30E, 0x314) overlaps the grid tail [0x30E, 0x310)
      const p = putCurve(b, 0x30e, 0x100, 4);
      // trusted pool axis right after the block end 0x314 → end-abut anchor
      const eData = putAxis(b, 0x314, 4, 50, 23);
      const maps = [gridMap(0x300, 4, 4, 0x201, 0x211)];
      return { b, maps, prefixed: [pax(eData, 4)], p };
    };
    // demoted grid → curve in its tail passes
    const dem = build(false);
    const outDem = partialCurveDetections(dem.b, dem.maps, dem.prefixed, cfg);
    expect(outDem.some((d) => d.address === dem.p && d.rows === 4)).toBe(true);
    // legit grid → veto stands, curve fails
    const leg = build(true);
    const outLeg = partialCurveDetections(leg.b, leg.maps, leg.prefixed, cfg);
    expect(outLeg.some((d) => d.address === leg.p)).toBe(false);
  });

  it('(c) pad closure: an odd-length w1 block chains at end+1 and the chain end-abuts a trusted edge', () => {
    const b = new Uint8Array(0x400);
    putAxis(b, 0x100, 5); // axis for curve A (count 5)
    putAxis(b, 0x110, 4); // axis for curve B (count 4)
    // A: [0x200, 0x207) — odd end; B starts at 0x208 = A.end + 1 pad byte
    const pA = putCurve(b, 0x200, 0x100, 5);
    const pB = putCurve(b, 0x208, 0x110, 4);
    // trusted pool axis whose span starts exactly at B's end 0x20E
    const eData = putAxis(b, 0x20e, 6, 40, 17);
    const out = partialCurveDetections(b, [], [pax(eData, 6)], cfg);
    expect(out.some((d) => d.address === pA && d.rows === 5)).toBe(true);
    expect(out.some((d) => d.address === pB && d.rows === 4)).toBe(true);
  });

  it("(d) F-adjax: [n][axis][hdr][data] self-anchored curve passes with no other anchor", () => {
    const b = new Uint8Array(0x400);
    const aData = putAxis(b, 0x180, 6); // [n][axis] ends at 0x187
    const p = putCurve(b, 0x187, 0x180, 6); // hdr immediately after the axis run
    const out = partialCurveDetections(b, [], [], cfg);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ address: p, rows: 6, cols: 1, yAxis: { address: aData, count: 6 } });
  });

  it('(e) NEGATIVE: a floating free candidate with no anchor emits nothing', () => {
    const b = new Uint8Array(0x400);
    putAxis(b, 0x100, 6);
    putCurve(b, 0x150, 0x100, 6); // valid candidate, fits free, but nothing anchors it
    const out = partialCurveDetections(b, [], [], cfg);
    expect(out).toHaveLength(0);
  });
});

describe('partialCurveDetections — synth-partial empirical-inertness pin (the spike mandate)', () => {
  // poolStructuralActive is TRUE on these fixtures — inertness is EMPIRICAL
  // (the discriminator measured zero passes at every rung), so pin it here.
  for (const name of ['synth-partial-201', 'synth-partial-203'] as const) {
    it(`${name}: ZERO detections`, { timeout: 60_000 }, () => {
      const bytes = new Uint8Array(
        readFileSync(new URL(`../../../fixtures/synthetic/${name}.bin`, import.meta.url))
      );
      const maps = scan(bytes, cfg).potentialMaps;
      const prefixed = scanPrefixedAxes(bytes, classifyRegions(bytes, cfg), cfg);
      expect(partialCurveDetections(bytes, maps, prefixed, cfg)).toHaveLength(0);
    });
  }
});
