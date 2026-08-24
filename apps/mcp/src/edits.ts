import { readValue, toPhysical, type MapDef, type Scaling, type ValueFormat } from '@binanalyzer/core';
import type { MapSource, SourcedMap } from './maps.js';

/** A decoded value: raw always; `value` only when a scaling makes it meaningful. */
export interface Decoded {
  raw: number;
  value?: number;
}

export type EditRow =
  | { kind: 'cell'; offset: number; mapId: string; mapName: string; source: MapSource;
      row: number; col: number; original: Decoded; current: Decoded }
  | { kind: 'axis'; offset: number; axisAddress: number; index: number; mapIds: string[];
      libId?: string; original: Decoded; current: Decoded }
  | { kind: 'checksum'; offset: number; checksumId: string; storedAt: number;
      byteLength: number; correctable: boolean; original: number; current: number }
  | { kind: 'raw'; offset: number; original: number; current: number };

export interface EditSummary {
  maps: Array<{ mapId: string; name: string; source: MapSource;
                cells: number; axisEntries: number; bytes: number }>;
  checksums: Array<{ checksumId: string; bytes: number }>;
  rawBytes: number;
}

/** One checksum block's stored value, read from BOTH buffers. */
export interface ChecksumPair {
  id: string;
  storedAt: number;
  originalStored: number;
  currentStored: number;
  correctable: boolean;
}

export interface AttributionInput {
  working: Uint8Array;
  original: Uint8Array;
  /** Precedence order is imposed inside; caller may pass any order. */
  maps: SourcedMap[];
  checksums: ChecksumPair[];
}

export interface AttributionResult {
  rows: EditRow[];
  summary: EditSummary;
  changedBytes: number;
}

/** Offsets where the working buffer differs from the file as opened. */
export function changedOffsets(working: Uint8Array, original: Uint8Array): Set<number> {
  const out = new Set<number>();
  const n = Math.min(working.length, original.length);
  for (let i = 0; i < n; i++) if (working[i] !== original[i]) out.add(i);
  return out;
}

/** Precedence rank, copied from findMap: confirmed beats imported beats potential. */
const RANK: Record<MapSource, number> = { confirmed: 0, imported: 1, potential: 2 };

const decode = (bytes: Uint8Array, offset: number, format: ValueFormat, scaling: Scaling): Decoded => {
  const raw = readValue(bytes, offset, format);
  // factor 0 collapses every raw value to the same physical one, so a physical
  // reading would be a lie rather than a convenience.
  return scaling.factor === 0 ? { raw } : { raw, value: toPhysical(raw, scaling) };
};

const cellOffset = (map: MapDef, row: number, col: number): number => {
  const index = map.orientation === 'row-major' ? row * map.cols + col : col * map.rows + row;
  return map.address + index * map.format.width;
};

/**
 * Attribute every changed byte to exactly one owner.
 *
 * One owner per byte is what makes the counts additive and the result
 * deterministic: without it a byte inside three overlapping potential maps
 * would be reported three times and the totals would not sum.
 */
export function attributeEdits(input: AttributionInput): AttributionResult {
  const { working, original, maps } = input;
  const changed = changedOffsets(working, original);
  const claimed = new Set<number>();
  const rows: EditRow[] = [];
  const perMap = new Map<string, { mapId: string; name: string; source: MapSource;
                                   cells: number; axisEntries: number; bytes: number }>();

  const ordered = [...maps].sort((a, b) =>
    RANK[a.source] - RANK[b.source] || (a.map.id < b.map.id ? -1 : a.map.id > b.map.id ? 1 : 0)
  );

  /** True when the span has a changed byte and no already-claimed byte. */
  const claimable = (start: number, width: number): boolean => {
    let touched = false;
    for (let i = start; i < start + width; i++) {
      if (claimed.has(i)) return false;
      if (changed.has(i)) touched = true;
    }
    return touched;
  };

  const claim = (start: number, width: number): void => {
    for (let i = start; i < start + width; i++) claimed.add(i);
  };

  const bump = (m: SourcedMap, field: 'cells' | 'axisEntries', bytes: number): void => {
    const cur = perMap.get(m.map.id) ??
      { mapId: m.map.id, name: m.map.name, source: m.source, cells: 0, axisEntries: 0, bytes: 0 };
    cur[field] += 1;
    cur.bytes += bytes;
    perMap.set(m.map.id, cur);
  };

  for (const m of ordered) {
    const { map } = m;
    const w = map.format.width;
    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        const off = cellOffset(map, r, c);
        if (off < 0 || off + w > working.length) continue;
        if (!claimable(off, w)) continue;
        claim(off, w);
        rows.push({
          kind: 'cell', offset: off, mapId: map.id, mapName: map.name, source: m.source,
          row: r, col: c,
          original: decode(original, off, map.format, map.scaling),
          current: decode(working, off, map.format, map.scaling),
        });
        bump(m, 'cells', w);
      }
    }
  }

  rows.sort((a, b) => a.offset - b.offset);
  return {
    rows,
    summary: { maps: [...perMap.values()], checksums: [], rawBytes: 0 },
    changedBytes: changed.size,
  };
}
