import type { AxisDef, BinImage, MapDef, Result } from '@binanalyzer/core';
import { validateMapDef } from '@binanalyzer/core';
import { importRomRaiderXml, isCurveShaped, toCanonicalCurve } from '@binanalyzer/formats';
import type { GroundTruth } from './groundtruth.js';

/**
 * Build a GroundTruth from a RomRaider definition XML + the fixture bin
 * (spec §5). MS41-specific address handling lives HERE, not in formats:
 * fo() is A13/A14 flash-bus scrambling, not RomRaider semantics
 * (RomRaider itself never descrambles).
 */
export function fo(storageAddress: number): number {
  return (0x10000 + storageAddress) ^ 0x4000;
}

/** 24KB CAL window: the valid storageaddress domain of fo(). */
const FO_WINDOW = 0x6000;

export interface GtBuildOptions {
  /** CAL-ID xmlid inside the def; required for multi-rom defs. */
  romId?: string;
  /** GroundTruth.fixture name, e.g. "ms41-e36m3-stock". */
  fixture: string;
  /** MapDef id prefix: ids become `${idPrefix}-0x<original sa, lowercase hex>`. */
  idPrefix: string;
  /** Apply fo() to every table/axis address (MS41 256KB full-read fixtures). */
  applyFo: boolean;
  /**
   * Truth class to build: '2d' (default) = the existing 2D-and-up two-axis
   * class; 'curve' = 1D curves (spec Phase 1 1D-curve detection). The two
   * classes are mutually exclusive truth sets — never mixed in one GroundTruth.
   */
  class?: '2d' | 'curve';
}

export function buildGroundTruth(
  defXml: string,
  bin: BinImage,
  opts: GtBuildOptions
): Result<{ truth: GroundTruth; warnings: string[] }> {
  const imported = importRomRaiderXml(defXml, opts.romId);
  if (!imported.ok) return imported;
  const warnings = [...imported.value.warnings];
  if ((opts.class ?? '2d') === 'curve') {
    return buildCurveGroundTruth(imported.value.maps, bin, opts, warnings);
  }
  const byAddress = new Map<number, MapDef>();
  for (const m of imported.value.maps) {
    // v1 truth class (matches the committed ms41 GT): 2D-and-up tables with
    // both axes — the RomRaider "3D" shape. Curves/scalars are out of the v1
    // engine's detection class (spec §4.3) and would poison locationRecall.
    if (m.rows < 2 || m.cols < 2 || m.xAxis === undefined || m.yAxis === undefined) continue;
    const sa = m.address;
    let address = sa;
    let xAxis = m.xAxis;
    let yAxis = m.yAxis;
    if (opts.applyFo) {
      if (sa >= FO_WINDOW) {
        warnings.push(`${m.name} @0x${sa.toString(16)}: outside the 24KB CAL window — skipped`);
        continue;
      }
      const mapAxis = (a: AxisDef): AxisDef | null => {
        if (a.kind !== 'referenced' || a.address === undefined) return a;
        if (a.address >= FO_WINDOW) return null;
        return { ...a, address: fo(a.address) };
      };
      const fx = mapAxis(xAxis);
      const fy = mapAxis(yAxis);
      if (fx === null || fy === null) {
        warnings.push(`${m.name} @0x${sa.toString(16)}: an axis lies outside the 24KB CAL window — skipped`);
        continue;
      }
      address = fo(sa);
      xAxis = fx;
      yAxis = fy;
    }
    const existing = byAddress.get(address);
    if (existing !== undefined) {
      warnings.push(`0x${address.toString(16)}: "${m.name}" is an alias of "${existing.name}" — kept the first`);
      continue;
    }
    // Dead-table filter: uniform 0x00/0xFF data is not a live map in THIS bin
    // (e.g. MS41.3 Speed-Density tables read all 0xFFFF) and is undetectable.
    const size = m.rows * m.cols * m.format.width;
    const slice = bin.bytes.subarray(address, address + size);
    if (slice.length === size && (slice[0] === 0x00 || slice[0] === 0xff) && slice.every((b) => b === slice[0])) {
      warnings.push(`${m.name} @0x${address.toString(16)}: uniform 0x${slice[0]!.toString(16).padStart(2, '0')} fill — dead table skipped`);
      continue;
    }
    const truthMap: MapDef = { ...m, id: `${opts.idPrefix}-0x${sa.toString(16)}`, address, xAxis, yAxis };
    const valid = validateMapDef(truthMap, bin.size);
    if (!valid.ok) {
      return { ok: false, error: `${truthMap.id} ("${m.name}"): ${valid.error} — wrong --fo flag for this bin framing?` };
    }
    byAddress.set(address, truthMap);
  }
  const maps = [...byAddress.values()].sort((a, b) => a.address - b.address);
  if (maps.length === 0) return { ok: false, error: 'no eligible truth maps (need rows ≥ 2, cols ≥ 2, both axes)' };
  return { ok: true, value: { truth: { fixture: opts.fixture, binSha256: bin.sha256, maps }, warnings } };
}

/**
 * Curve truth class (spec Phase 1 1D-curve detection): 1D tables — exactly
 * one of rows/cols === 1 — with one REFERENCED axis, matching the engine's
 * curve emission shape (N×1 + yAxis, no xAxis).
 *
 * Two exclusions beyond the 2D path:
 * - shared-axis pseudo-curves: a "curve" whose (pre-fo) storageaddress is
 *   itself cited as an X/Y axis by ANY other imported table is really an
 *   axis exposed as an editable def entry (e.g. 0x898/0x8b2/0x2388/0x235b),
 *   not a curve — excluded.
 * - dual-alias dedupe: the same (post-fo) address may be defined twice as
 *   curve-shaped entries (e.g. the 0x2AD6-style alias) — first import-order
 *   entry wins, same tie-break as the 2D alias dedupe above.
 */
function buildCurveGroundTruth(
  maps: MapDef[],
  bin: BinImage,
  opts: GtBuildOptions,
  warnings: string[]
): Result<{ truth: GroundTruth; warnings: string[] }> {
  const axisAddrs = new Set<number>();
  for (const m of maps) {
    for (const a of [m.xAxis, m.yAxis]) {
      if (a?.kind === 'referenced' && a.address !== undefined) axisAddrs.add(a.address);
    }
  }
  const byAddress = new Map<number, MapDef>();
  for (const m of maps) {
    if (!isCurveShaped(m)) continue;
    const sa = m.address;
    if (axisAddrs.has(sa)) continue; // shared-axis pseudo-curve, not a real curve
    const cm = toCanonicalCurve(m);
    const axisSrc = cm.yAxis;
    if (axisSrc === undefined || axisSrc.kind !== 'referenced' || axisSrc.address === undefined) continue;
    let address = sa;
    let axis: AxisDef = axisSrc;
    if (opts.applyFo) {
      if (sa >= FO_WINDOW) {
        warnings.push(`${m.name} @0x${sa.toString(16)}: outside the 24KB CAL window — skipped`);
        continue;
      }
      if (axisSrc.address >= FO_WINDOW) {
        warnings.push(`${m.name} @0x${sa.toString(16)}: an axis lies outside the 24KB CAL window — skipped`);
        continue;
      }
      address = fo(sa);
      axis = { ...axisSrc, address: fo(axisSrc.address) };
    }
    const existing = byAddress.get(address);
    if (existing !== undefined) {
      warnings.push(`0x${address.toString(16)}: "${m.name}" is a curve alias of "${existing.name}" — kept the first`);
      continue;
    }
    // Dead-table filter: uniform 0x00/0xFF data is not a live curve in THIS
    // bin — same idiom as the 2D path above.
    const count = cm.rows;
    const size = count * m.format.width;
    const slice = bin.bytes.subarray(address, address + size);
    if (slice.length === size && (slice[0] === 0x00 || slice[0] === 0xff) && slice.every((b) => b === slice[0])) {
      warnings.push(`${m.name} @0x${address.toString(16)}: uniform 0x${slice[0]!.toString(16).padStart(2, '0')} fill — dead curve skipped`);
      continue;
    }
    // Emit N×1 + yAxis (no xAxis) — the engine's curve orientation. xAxis is
    // dropped by destructuring rather than assigned `undefined`, honoring
    // exactOptionalPropertyTypes.
    const { xAxis: _srcXAxis, yAxis: _srcYAxis, ...rest } = cm;
    const truthMap: MapDef = {
      ...rest,
      id: `${opts.idPrefix}-0x${sa.toString(16)}`,
      address,
      rows: count,
      cols: 1,
      yAxis: axis,
    };
    // Harness parity: a validateMapDef failure WARNS and KEEPS the entry —
    // never fails the build. Motivating real-def case: 0x6cc "ECT Sensor
    // Scaling" (2023 MS41 def) declares a referenced yAxis with count 1 on a
    // 16-cell curve (the importer assigns referenced-axis count from the
    // table dims, so a 1×16 table's Y axis imports as count 1). The
    // validated harness curveGroundTruth has no validation step, INCLUDES
    // such entries, and the pinned curve-GT counts (64/71) and acceptance
    // numbers were measured with them — dropping or hard-failing here would
    // break that parity.
    const valid = validateMapDef(truthMap, bin.size);
    if (!valid.ok) {
      warnings.push(`${truthMap.id} ("${m.name}"): ${valid.error} — kept anyway (degenerate declared axis; harness parity)`);
    }
    byAddress.set(address, truthMap);
  }
  const outMaps = [...byAddress.values()].sort((a, b) => a.address - b.address);
  if (outMaps.length === 0) {
    return { ok: false, error: 'no eligible truth maps (need a 1D curve shape with one referenced axis)' };
  }
  return { ok: true, value: { truth: { fixture: opts.fixture, binSha256: bin.sha256, maps: outMaps }, warnings } };
}
