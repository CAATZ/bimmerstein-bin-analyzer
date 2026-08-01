import type { MapDef, Result } from '@binanalyzer/core';
import type { OpenBin } from './session.js';

export type MapSource = 'potential' | 'imported';
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
  if (want === 'imported' || want === 'all') {
    if (entry.imported === undefined) {
      if (want === 'imported') return { ok: false, error: `bin "${entry.name}" has no imported definition — call import_definition first` };
    } else {
      for (const m of entry.imported.maps) out.push({ map: m, source: 'imported' });
    }
  }
  return { ok: true, value: out };
}

/** Imported maps win an id collision (an explicit import beats a guess). */
export function findMap(entry: OpenBin, mapId: string): SourcedMap | undefined {
  const imported = entry.imported?.maps.find((m) => m.id === mapId);
  if (imported !== undefined) return { map: imported, source: 'imported' };
  const potential = entry.scan?.result.potentialMaps.find((m) => m.id === mapId);
  return potential !== undefined ? { map: potential, source: 'potential' } : undefined;
}
