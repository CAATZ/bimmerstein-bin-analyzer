import type { AxisDef, AxisLibEntry, MapDef, Result } from './types.js';

/**
 * MapDef invariants (spec §8): a MapDef accepted here is always fully readable.
 * - address ≥ 0; address + rows*cols*format.width ≤ binSize
 * - rows ≥ 1, cols ≥ 1
 * - xAxis.count === cols and yAxis.count === rows (row-major; swapped for col-major)
 * - referenced axes fully inside the bin
 * - confidence present iff provenance === 'auto'
 * - detector (detection tier) only on provenance === 'auto' maps
 * Implemented in plan Phase 1 (TDD).
 */

function fail(error: string): Result<MapDef> {
  return { ok: false, error };
}

function axisError(axis: AxisDef, expectedCount: number, binSize: number, label: string): string | undefined {
  if (axis.count !== expectedCount) return `${label} axis count ${axis.count} !== ${expectedCount}`;
  if (axis.kind === 'referenced') {
    if (axis.address === undefined || !axis.format) return `${label} referenced axis missing address/format`;
    if (axis.address < 0 || axis.address + axis.count * axis.format.width > binSize) {
      return `${label} axis out of bounds`;
    }
  }
  if (axis.kind === 'literal' && (!axis.values || axis.values.length !== axis.count)) {
    return `${label} literal axis values length mismatch`;
  }
  return undefined;
}

export function validateMapDef(map: MapDef, binSize: number): Result<MapDef> {
  if (map.rows < 1 || map.cols < 1) return fail('rows and cols must be ≥ 1');
  if (map.address < 0) return fail('address must be ≥ 0');
  const dataEnd = map.address + map.rows * map.cols * map.format.width;
  if (dataEnd > binSize) return fail(`map data [${map.address}, ${dataEnd}) exceeds bin size ${binSize}`);
  // row-major: xAxis spans cols, yAxis spans rows; col-major swaps them.
  const xCount = map.orientation === 'row-major' ? map.cols : map.rows;
  const yCount = map.orientation === 'row-major' ? map.rows : map.cols;
  if (map.xAxis) {
    const e = axisError(map.xAxis, xCount, binSize, 'x');
    if (e) return fail(e);
  }
  if (map.yAxis) {
    const e = axisError(map.yAxis, yCount, binSize, 'y');
    if (e) return fail(e);
  }
  if (map.provenance === 'auto' && map.confidence === undefined) return fail('auto map requires confidence');
  if (map.provenance !== 'auto' && map.confidence !== undefined) return fail('confidence only on auto maps');
  if (map.confidence !== undefined && (map.confidence < 0 || map.confidence > 1)) return fail('confidence out of [0,1]');
  if (map.provenance !== 'auto' && map.detector !== undefined) return fail('detector only on auto maps');
  if (map.states !== undefined) {
    if (map.states.length === 0) return fail('states must be non-empty when present');
    if (map.cols !== 1 || map.format.width !== 1) return fail('switch (states) requires cols 1 and width 1');
    if (map.format.signed) return fail('switch (states) requires unsigned format');
    if (map.scaling.factor !== 1 || map.scaling.offset !== 0 || map.scaling.rawExpression !== undefined) {
      return fail('switch (states) requires identity scaling');
    }
    if (map.xAxis !== undefined || map.yAxis !== undefined) return fail('switch (states) cannot carry axes');
    const size = map.rows * map.cols * map.format.width;
    for (const s of map.states) {
      if (s.name.length === 0) return fail('state name must be non-empty');
      if (s.data.length !== size) return fail(`state "${s.name}" data length ${s.data.length} !== ${size}`);
      if (s.data.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
        return fail(`state "${s.name}" data must be integers in [0, 255]`);
      }
    }
  }
  return { ok: true, value: map };
}

/**
 * Axis Library entry invariants (2026-07-29 shared-axis-library spec §2): an
 * entry accepted here can be stamped onto any dimension-matching map and
 * decoded by readAxisValues against a bin of `binSize` bytes. Uniqueness of
 * entry ids is a LIST-level property checked where lists are built.
 */
export function validateAxisLibEntry(entry: AxisLibEntry, binSize: number): Result<AxisLibEntry> {
  const failEntry = (error: string): Result<AxisLibEntry> => ({ ok: false, error });
  if (entry.id.length === 0) return failEntry('entry id must be non-empty');
  if (entry.name.length === 0) return failEntry('entry name must be non-empty');
  const axis = entry.axis;
  if (axis.kind === 'index') return failEntry(`entry "${entry.name}": axis kind must be referenced or literal`);
  if (axis.libId !== undefined) return failEntry(`entry "${entry.name}": the entry's own axis cannot carry libId`);
  if (!Number.isInteger(axis.count) || axis.count < 1) return failEntry(`entry "${entry.name}": count must be an integer ≥ 1`);
  const e = axisError(axis, axis.count, binSize, `entry "${entry.name}"`);
  if (e !== undefined) return failEntry(e);
  return { ok: true, value: entry };
}
