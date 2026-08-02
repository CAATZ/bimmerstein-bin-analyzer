import type { MapDef, Result } from '@binanalyzer/core';
import type { OpenBin } from './session.js';

export type MapSource = 'potential' | 'imported' | 'confirmed';
export type MapSourceFilter = MapSource | 'all';

export interface SourcedMap {
  map: MapDef;
  source: MapSource;
}

/** Maps of the requested provenance, with a prerequisite-naming error. */
export function sourcedMaps(entry: OpenBin, want: MapSourceFilter): Result<SourcedMap[]> {
  const out: SourcedMap[] = [];
  if (want === 'potential' || want === 'all') {
    if (entry.scan === undefined) {
      if (want === 'potential') return { ok: false, error: `bin "${entry.name}" has not been scanned — call scan_bin first` };
    } else {
      for (const m of entry.scan.result.potentialMaps) out.push({ map: m, source: 'potential' });
    }
  }
  if (want === 'confirmed' || want === 'all') {
    if (entry.confirmed === undefined || entry.confirmed.length === 0) {
      if (want === 'confirmed') {
        return {
          ok: false,
          error: `the app has not confirmed any maps in "${entry.name}" — the user promotes or imports maps in the app`,
        };
      }
    } else {
      for (const m of entry.confirmed) out.push({ map: m, source: 'confirmed' });
    }
  }
  if (want === 'imported' || want === 'all') {
    if (entry.imported === undefined) {
      if (want === 'imported') return { ok: false, error: `bin "${entry.name}" has no imported definition — call import_definition first` };
    } else {
      for (const m of entry.imported.maps) out.push({ map: m, source: 'imported' });
    }
  }
  return { ok: true, value: out };
}

/**
 * Precedence on an id collision: confirmed (what the USER authored, co-pilot
 * mode) beats imported (an explicit import) beats potential (a guess).
 */
export function findMap(entry: OpenBin, mapId: string): SourcedMap | undefined {
  const confirmed = entry.confirmed?.find((m) => m.id === mapId);
  if (confirmed !== undefined) return { map: confirmed, source: 'confirmed' };
  const imported = entry.imported?.maps.find((m) => m.id === mapId);
  if (imported !== undefined) return { map: imported, source: 'imported' };
  const potential = entry.scan?.result.potentialMaps.find((m) => m.id === mapId);
  return potential !== undefined ? { map: potential, source: 'potential' } : undefined;
}
