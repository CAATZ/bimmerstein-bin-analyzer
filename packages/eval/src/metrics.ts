import type { AxisDef, MapDef, ValueFormat } from '@binanalyzer/core';

/**
 * Detection-quality metrics (spec §5). A detection HITS a truth map when
 * byte-range IoU ≥ 0.5.
 * - locationRecall: % truth maps hit
 * - exactStartRecall: % truth maps hit at the exact first data byte
 * - exactLayoutRecall: % truth maps with exact start, shape, storage order and format
 * - axisPairRecall: % axis-bearing truth maps with exact layout and all known axis roles
 * - structureRecall: % truth maps hit with rows×cols exact or transposed
 * - axisRecall: among structure hits whose TRUTH map has ≥1 referenced axis,
 *   % with ≥1 correct detected axis address (0 when none are axis-eligible)
 * - falsePositiveDensity: non-hitting detections per 100 KB of data region
 * Implemented in plan Phase 4 (TDD).
 */
export interface EvalScores {
  locationRecall: number;
  exactStartRecall: number;
  exactLayoutRecall: number;
  axisPairRecall: number;
  structureRecall: number;
  axisRecall: number;
  falsePositiveDensity: number;
  truthCount: number;
  detectedCount: number;
}

function span(m: MapDef): [number, number] {
  return [m.address, m.address + m.rows * m.cols * m.format.width];
}

function iou(a: [number, number], b: [number, number]): number {
  const inter = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  const union = a[1] - a[0] + (b[1] - b[0]) - inter;
  return union <= 0 ? 0 : inter / union;
}

function axisAddresses(m: MapDef): number[] {
  const out: number[] = [];
  if (m.xAxis?.kind === 'referenced' && m.xAxis.address !== undefined) out.push(m.xAxis.address);
  if (m.yAxis?.kind === 'referenced' && m.yAxis.address !== undefined) out.push(m.yAxis.address);
  return out;
}

function sameFormat(a: ValueFormat | undefined, b: ValueFormat | undefined): boolean {
  return a !== undefined && b !== undefined && a.width === b.width && a.signed === b.signed &&
    (a.float === true) === (b.float === true) && (a.width === 1 || a.endianness === b.endianness);
}

function knownAxis(axis: AxisDef | undefined): boolean {
  return axis !== undefined && axis.kind !== 'index';
}

function sameAxis(detected: AxisDef | undefined, truth: AxisDef | undefined): boolean {
  if (!knownAxis(truth)) return true;
  if (!detected || !truth || detected.kind !== truth.kind || detected.count !== truth.count) return false;
  if (truth.kind === 'referenced') return detected.address === truth.address && sameFormat(detected.format, truth.format);
  return truth.values !== undefined && detected.values?.length === truth.values.length &&
    truth.values.every((v, i) => v === detected.values![i]);
}

export function scoreDetections(
  detected: MapDef[],
  truth: MapDef[],
  dataRegionBytes: number
): EvalScores {
  // all candidate pairs with IoU ≥ 0.5, matched greedily by IoU descending
  const pairs: Array<{ t: number; d: number; iou: number }> = [];
  truth.forEach((t, ti) =>
    detected.forEach((d, di) => {
      const v = iou(span(t), span(d));
      if (v >= 0.5) pairs.push({ t: ti, d: di, iou: v });
    })
  );
  pairs.sort((a, b) => b.iou - a.iou);
  const truthMatch = new Map<number, number>();
  const usedDet = new Set<number>();
  for (const p of pairs) {
    if (truthMatch.has(p.t) || usedDet.has(p.d)) continue;
    truthMatch.set(p.t, p.d);
    usedDet.add(p.d);
  }
  let structureHits = 0;
  let exactStarts = 0;
  let exactLayouts = 0;
  let axisPairs = 0;
  const pairEligible = truth.filter((t) => knownAxis(t.xAxis) || knownAxis(t.yAxis)).length;
  let axisEligible = 0; // structure hits whose TRUTH map has ≥1 referenced axis
  let axisHits = 0;
  for (const [ti, di] of truthMatch) {
    const t = truth[ti]!;
    const d = detected[di]!;
    if (d.address === t.address) exactStarts++;
    if (d.address === t.address && d.rows === t.rows && d.cols === t.cols &&
        d.orientation === t.orientation && sameFormat(d.format, t.format)) {
      exactLayouts++;
      if ((knownAxis(t.xAxis) || knownAxis(t.yAxis)) && sameAxis(d.xAxis, t.xAxis) && sameAxis(d.yAxis, t.yAxis)) axisPairs++;
    }
    const structural = (d.rows === t.rows && d.cols === t.cols) || (d.rows === t.cols && d.cols === t.rows);
    if (!structural) continue;
    structureHits++;
    const tAxes = axisAddresses(t);
    if (tAxes.length === 0) continue; // no truth axes → not scorable for axis recall
    axisEligible++;
    if (axisAddresses(d).some((a) => tAxes.includes(a))) axisHits++;
  }
  const n = truth.length;
  const fp = detected.length - usedDet.size;
  return {
    locationRecall: n === 0 ? 0 : truthMatch.size / n,
    exactStartRecall: n === 0 ? 0 : exactStarts / n,
    exactLayoutRecall: n === 0 ? 0 : exactLayouts / n,
    axisPairRecall: pairEligible === 0 ? 0 : axisPairs / pairEligible,
    structureRecall: n === 0 ? 0 : structureHits / n,
    axisRecall: axisEligible === 0 ? 0 : axisHits / axisEligible,
    falsePositiveDensity: dataRegionBytes <= 0 ? 0 : fp / (dataRegionBytes / 102400),
    truthCount: n,
    detectedCount: detected.length,
  };
}
