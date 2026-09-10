import { formatPhysical, readAxisValues, readGrid, readValue, toPhysical } from '@binanalyzer/core';
import type { AxisDef, MapDef, Scaling, ValueFormat } from '@binanalyzer/core';

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
  xAxis?: { label: string; values: string[] };
  yAxis?: { label: string; values: string[] };
  valueLabel?: string;
  digits?: number;
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
export function gridFromMap(bytes: Uint8Array, map: MapDef, transposed = false): SurfaceGrid {
  const values = readGrid(bytes, map);
  if (transposed && map.rows > 1 && map.cols > 1) {
    return withMinMax(map.cols, map.rows, Array.from({ length: map.cols }, (_, c) => values.map((row) => row[c]!)));
  }
  return withMinMax(map.rows, map.cols, values);
}

/** Physical values are for plotting only; Map view still consumes the raw grid. */
export function surfaceFromMap(bytes: Uint8Array, map: MapDef, transposed = false): SurfaceGrid {
  const swap = transposed && map.rows > 1 && map.cols > 1;
  const raw = gridFromMap(bytes, map, swap);
  const grid = withMinMax(raw.rows, raw.cols, raw.values.map((row) => row.map((v) => toPhysical(v, map.scaling))));
  const label = (name: string, scaling?: Scaling): string => scaling?.rawExpression !== undefined
    ? `${name} (raw; unsupported conversion)`
    : `${name} (${scaling?.units || 'raw'})`;
  const axis = (which: 'x' | 'y', count: number): NonNullable<SurfaceGrid['xAxis']> => {
    const def = map[sourceAxis(which, swap, map.orientation) === 'x' ? 'xAxis' : 'yAxis'];
    if (def !== undefined && def.kind !== 'index') {
      try {
        const values = readAxisValues(bytes, def);
        if (values.length === count && values.every(Number.isFinite)) {
          return { label: label(def.name || which.toUpperCase(), def.scaling), values: axisLabels(bytes, def, count) };
        }
      } catch { /* Unreadable axes use the same index fallback as the table. */ }
    }
    return { label: `${which.toUpperCase()} (index)`, values: Array.from({ length: count }, (_, i) => String(i)) };
  };
  return { ...grid, xAxis: axis('x', grid.cols), yAxis: axis('y', grid.rows),
    valueLabel: label(map.name || 'Value', map.scaling), digits: map.scaling.rawExpression === undefined ? map.scaling.digits : 0 };
}

/** Transposition is its own inverse; selections stay in the map's original coordinates. */
export function sourceCell(row: number, col: number, transposed: boolean): { row: number; col: number } {
  return transposed ? { row: col, col: row } : { row, col };
}

export function sourceAxis(which: 'x' | 'y', transposed: boolean, orientation: MapDef['orientation'] = 'row-major'): 'x' | 'y' {
  // Column-major definitions bind X to rows and Y to columns.
  return transposed !== (orientation === 'col-major') ? (which === 'x' ? 'y' : 'x') : which;
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
