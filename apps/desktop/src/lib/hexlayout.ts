import type { ValueFormat } from '@binanalyzer/core';
import type { Region, RegionKind } from '@binanalyzer/engine';

/**
 * Pure hexdump-grid arithmetic (ui-architecture: components stay thin).
 * A GridGeometry describes the virtual grid: `origin` is the first displayed
 * byte, cells are `width` bytes, rows are `columns` cells. All functions are
 * total — they clamp or return null instead of throwing, so the canvas can
 * call them with any scroll/mouse state.
 */

export interface GridGeometry {
  origin: number;
  columns: number;
  width: 1 | 2 | 4;
  totalBytes: number;
}

export function bytesPerRow(g: GridGeometry): number {
  return g.columns * g.width;
}

export function rowCount(g: GridGeometry): number {
  const usable = g.totalBytes - g.origin;
  return usable <= 0 ? 0 : Math.ceil(usable / bytesPerRow(g));
}

export function offsetOfCell(g: GridGeometry, row: number, col: number): number {
  return g.origin + row * bytesPerRow(g) + col * g.width;
}

export function rowOfOffset(g: GridGeometry, offset: number): number {
  if (offset <= g.origin) return 0;
  return Math.floor((offset - g.origin) / bytesPerRow(g));
}

export function cellOfOffset(g: GridGeometry, offset: number): { row: number; col: number } | null {
  if (offset < g.origin || offset >= g.totalBytes) return null;
  const rel = offset - g.origin;
  const bpr = bytesPerRow(g);
  return { row: Math.floor(rel / bpr), col: Math.floor((rel % bpr) / g.width) };
}

export interface RowRange {
  first: number;
  last: number;
}

/** Inclusive visible row window; `last < first` means nothing visible. */
export function visibleRows(scrollTop: number, viewportHeight: number, rowHeight: number, totalRows: number): RowRange {
  if (totalRows <= 0 || viewportHeight <= 0) return { first: 0, last: -1 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight));
  const last = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / rowHeight) - 1);
  return { first, last };
}

/** Regions are contiguous and sorted (engine contract) — binary search by start. */
export function regionKindAt(list: Region[], offset: number): RegionKind | undefined {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = list[mid]!;
    if (offset < r.start) hi = mid - 1;
    else if (offset >= r.end) lo = mid + 1;
    else return r.kind;
  }
  return undefined;
}

export function defaultRawRange(format: ValueFormat): { min: number; max: number } {
  if (format.float === true) return { min: 0, max: 1 }; // float bins: Ctrl+B sets a real range
  const bits = format.width * 8;
  return format.signed
    ? { min: -(2 ** (bits - 1)), max: 2 ** (bits - 1) - 1 }
    : { min: 0, max: 2 ** bits - 1 };
}

export function barFraction(value: number, range: { min: number; max: number }): number {
  if (range.max <= range.min) return 0;
  const f = (value - range.min) / (range.max - range.min);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Hex text always shows the raw unsigned bit pattern (signed −1 renders ff). */
export function hexCell(raw: number, width: 1 | 2 | 4): string {
  const bits = width * 8;
  const unsigned = raw < 0 ? raw + 2 ** bits : raw;
  return Math.trunc(unsigned).toString(16).padStart(width * 2, '0');
}

export interface CellMetrics {
  gutterWidth: number;
  cellWidth: number;
  rowHeight: number;
}

/** x/y in CSS px relative to the grid's top-left, y INCLUDING scrollTop. */
export function cellAtPoint(g: GridGeometry, m: CellMetrics, x: number, y: number): { row: number; col: number } | null {
  const row = Math.floor(y / m.rowHeight);
  if (row < 0 || row >= rowCount(g)) return null;
  const col = Math.floor((x - m.gutterWidth) / m.cellWidth);
  if (col < 0 || col >= g.columns) return null;
  return { row, col };
}

export interface MapChip {
  id: string;
  name: string;
  row: number;
  col: number;
  potential: boolean;
}

export function chipsForRows(
  list: Array<{ id: string; name: string; address: number; potential: boolean }>,
  g: GridGeometry,
  firstRow: number,
  lastRow: number
): MapChip[] {
  const chips: MapChip[] = [];
  for (const m of list) {
    const cell = cellOfOffset(g, m.address);
    if (cell === null || cell.row < firstRow || cell.row > lastRow) continue;
    chips.push({ id: m.id, name: m.name, row: cell.row, col: cell.col, potential: m.potential });
  }
  return chips;
}
