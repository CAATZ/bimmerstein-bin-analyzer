import type { AxisDef, MapDef } from '@binanalyzer/core';
import { readAxisValues, readValue, toPhysical } from '@binanalyzer/core';

/**
 * Chart-ready series for a curve-shaped map (rows===1 or cols===1). ALL byte
 * decoding goes through core codecs (ui-architecture rule); never throws so
 * views can never trigger core's RangeError.
 */

/**
 * Curve-shape predicate for MapDef, re-exported here as this desktop app's
 * single import point for curve-related UI logic (alongside curveSeries).
 * The logic itself lives in `@binanalyzer/formats` (single source of truth,
 * already tested there against the exact same rows/cols cases) — this file
 * does not reimplement it, only gives App.svelte and Sidebar.svelte one
 * place to import it from instead of each re-deriving the predicate inline.
 */
export { isCurveShaped } from '@binanalyzer/formats';

export interface CurveSeries {
  /** physical values along the curve's long dimension */
  y: number[];
  /** numeric x positions: decoded axis cell values, or 0..n-1 */
  x: number[];
  xIsIndex: boolean;
  /** the curve's single axis, if bound (for labels/units) */
  axis: AxisDef | undefined;
}

/** Chart-ready series for a curve-shaped map. Pure; never throws (axis decode
 *  failures fall back to index X, matching griddata's posture). */
export function curveSeries(bytes: Uint8Array, map: MapDef): CurveSeries {
  const n = Math.max(map.rows, map.cols);
  const w = map.format.width;
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const off = map.address + i * w;
    if (off + w > bytes.length) break;
    y.push(toPhysical(readValue(bytes, off, map.format), map.scaling));
  }
  // Deliberately more forgiving than formats' toCanonicalCurve (which skips
  // pathological axis-side shapes): the UI charts whatever single axis exists.
  // Keep in sync conceptually — see packages/formats/src/curve.ts.
  const axis = map.rows >= map.cols ? (map.yAxis ?? map.xAxis) : (map.xAxis ?? map.yAxis);
  if (axis !== undefined) {
    try {
      const vals = readAxisValues(bytes, axis);
      if (vals.length === y.length) return { y, x: vals, xIsIndex: false, axis };
    } catch {
      // fall through to index
    }
  }
  return { y, x: y.map((_, i) => i), xIsIndex: true, axis };
}
