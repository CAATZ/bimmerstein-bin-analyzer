import { formatPhysical, readAxisValues, readGrid, readValue } from '@binanalyzer/core';
import type { AxisDef, MapDef, ValueFormat } from '@binanalyzer/core';

/**
 * Selection/map → value grids for the 2D/3D/Map/preview views. ALL byte
 * decoding goes through core codecs (ui-architecture rule); every function
 * clamps to the bin so views can never trigger core's RangeError.
 */

export interface SurfaceGrid {
  rows: number;
  cols: number;
  values: number[][];
  min: number;
  max: number;
}

function withMinMax(rows: number, cols: number, values: number[][]): SurfaceGrid {
  let min = Infinity;
  let max = -Infinity;
  for (const row of values) {
    for (const v of row) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { rows, cols, values, min, max };
}

export function gridFromSelection(
  bytes: Uint8Array,
  start: number,
  end: number,
  cols: number,
  format: ValueFormat
): SurfaceGrid | null {
  if (cols < 1) return null;
  const w = format.width;
  const from = Math.max(0, start);
  const to = Math.min(end, bytes.length);
  const cells = Math.floor((to - from) / w);
  const rows = Math.floor(cells / cols);
  if (rows < 1) return null;
  const values: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) row.push(readValue(bytes, from + (r * cols + c) * w, format));
    values.push(row);
  }
  return withMinMax(rows, cols, values);
}

/** Caller passes a VALIDATED MapDef (store invariant) — readGrid cannot go out of range. */
export function gridFromMap(bytes: Uint8Array, map: MapDef): SurfaceGrid {
  return withMinMax(map.rows, map.cols, readGrid(bytes, map));
}

export function seriesFromRange(bytes: Uint8Array, start: number, count: number, format: ValueFormat): number[] {
  const w = format.width;
  const from = Math.max(0, start);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const off = from + i * w;
    if (off + w > bytes.length) break;
    out.push(readValue(bytes, off, format));
  }
  return out;
}

/** Axis header labels for the Map view; falls back to 0..n-1 when absent/unreadable. */
export function axisLabels(bytes: Uint8Array, axis: AxisDef | undefined, count: number): string[] {
  const indices = (): string[] => Array.from({ length: count }, (_, i) => String(i));
  if (axis === undefined) return indices();
  try {
    const values = readAxisValues(bytes, axis);
    const scaling = axis.scaling;
    return values.map((v) => (scaling ? formatPhysical(v, scaling) : String(v)));
  } catch {
    return indices(); // malformed/out-of-range axis — never crash a view
  }
}
