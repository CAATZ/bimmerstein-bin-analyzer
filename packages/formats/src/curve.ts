import type { MapDef } from '@binanalyzer/core';

/** A 1D curve: exactly one of rows/cols is 1 (1×1 scalars and grids are not curves). */
export function isCurveShaped(map: Pick<MapDef, 'rows' | 'cols'>): boolean {
  return (map.rows === 1) !== (map.cols === 1);
}

/**
 * Engine-canonical curve orientation: rows = N, cols = 1, the single axis on
 * yAxis (spec 2026-07-15 Phase 2 §F1). RomRaider defs may declare the mirror
 * (sizex + X Axis → 1×N + xAxis, a valid construct the importer mirrors
 * faithfully); consumers that need ONE orientation call this. The byte layout
 * of a row-major 1×N and N×1 table is identical, so only dims/axis-side move —
 * address/format/scaling are untouched, and a declared axis count is preserved
 * verbatim (degenerate def declarations are data, e.g. the 0x6cc count-1 yAxis).
 * Identity (same reference) for non-curves and already-canonical curves.
 * Pathological shapes (a curve declaring BOTH axes, or an N×1 declaring only
 * an xAxis) are self-contradictory defs: both-axes resolves xAxis-first and
 * drops the other; N×1+xAxis-only returns identity (no yAxis) — conservative
 * for GT consumers, which skip axis-less curves.
 */
export function toCanonicalCurve(map: MapDef): MapDef {
  if (!isCurveShaped(map) || map.cols === 1) return map;
  const { xAxis, yAxis, ...rest } = map;
  const out: MapDef = { ...rest, rows: map.cols, cols: 1 };
  const axis = xAxis ?? yAxis;
  if (axis !== undefined) out.yAxis = axis;
  return out;
}
