import { validateMapDef, type MapDef, type Result } from '@binanalyzer/core';
import { buildPoolIndex, classifyRegions, DEFAULT_SCAN_CONFIG, endEdgeOk, poolAnchors,
  scanPrefixedAxes, scanTables, startEdgeOk, type TableCandidate } from '@binanalyzer/engine';

export type TableLayout = Pick<MapDef, 'address' | 'rows' | 'cols' | 'format'>;
export interface LayoutCandidate extends TableCandidate {
  topEdge: boolean;
  bottomEdge: boolean;
  axisPairs: number;
}
export type LayoutReviewResult = { candidates: LayoutCandidate[] } | { error: string };

/** Reuse the scanner without its winner selection; candidates are advisory. */
export function reviewLayouts(bytes: Uint8Array, map: MapDef): LayoutCandidate[] {
  if (!validateMapDef(map, bytes.length).ok || map.states !== undefined || map.rows < 2 || map.cols < 2) return [];
  const cfg = DEFAULT_SCAN_CONFIG;
  const maxSpan = cfg.table.maxRows * cfg.table.maxCols * Math.max(...cfg.table.widths);
  const size = map.rows * map.cols * map.format.width;
  if (size > maxSpan) return [];
  const end = map.address + size;
  const regions = classifyRegions(bytes, cfg);
  // A full maximum-size table on either side prevents the bounded sweep from
  // introducing artificial edges into candidates that overlap this map.
  const nearby = regions.filter(r => r.kind === 'data').map(r => ({ ...r,
    start: Math.max(r.start, map.address - maxSpan), end: Math.min(r.end, end + maxSpan),
  })).filter(r => r.start < r.end);
  const index = buildPoolIndex(scanPrefixedAxes(bytes, regions, cfg));
  return scanTables(bytes, nearby, cfg).filter(c => {
    const length = c.rows * c.cols * c.format.width;
    const overlap = Math.max(0, Math.min(end, c.address + length) - Math.max(map.address, c.address));
    return overlap / Math.min(size, length) > cfg.score.overlapMax;
  }).map(c => ({ ...c,
    topEdge: startEdgeOk(bytes, c, cfg.pool.edgeMin),
    bottomEdge: endEdgeOk(bytes, c, cfg.pool.endEdgeMin),
    axisPairs: [...poolAnchors(c, index, cfg)].length,
  })).sort((a, b) => Math.abs(a.address - map.address) - Math.abs(b.address - map.address)
    || a.address - b.address || a.format.width - b.format.width
    || a.format.endianness.localeCompare(b.format.endianness) || a.rows - b.rows || a.cols - b.cols);
}

/** Build the exact definition previewed and applied; axes retain their identity. */
export function mapWithLayout(current: MapDef, layout: TableLayout, binSize: number): Result<MapDef> {
  if (current.states !== undefined || current.rows < 2 || current.cols < 2 || layout.rows < 2 || layout.cols < 2) {
    return { ok: false, error: 'Layout review applies to grids only' };
  }
  const next: MapDef = { ...current, address: layout.address, rows: layout.rows, cols: layout.cols,
    format: { ...layout.format }, orientation: 'row-major' };
  if (next.xAxis?.count !== next.cols) delete next.xAxis;
  if (next.yAxis?.count !== next.rows) delete next.yAxis;
  return validateMapDef(next, binSize);
}
