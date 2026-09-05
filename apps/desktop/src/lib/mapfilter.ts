import type { DetectorTier, MapDef } from '@binanalyzer/core';
import { isCurveShaped } from './curvedata.js';
import { isSwitch } from './switchdata.js';

export interface MapFilter {
  query: string;
  shape: 'all' | 'grid' | 'curve' | 'switch';
  detector: 'all' | DetectorTier;
}

export const DEFAULT_MAP_FILTER: MapFilter = { query: '', shape: 'all', detector: 'all' };
export const DETECTION_METHODS: Record<DetectorTier, { label: string; title: string }> = {
  family: { label: 'family', title: 'Family-specific analysis using code references or structural fallbacks.' },
  structural: { label: 'struct', title: 'Placed from count-prefixed axis lengths and table packing. Structural candidates share a fixed score.' },
  pool: { label: 'pool', title: 'Table shape inferred from bytes and associated with nearby shared axes.' },
  generic: { label: 'byte', title: 'Table shape inferred from byte smoothness.' },
};

export function detectionDescription(map: MapDef): string {
  const method = map.detector ? DETECTION_METHODS[map.detector].title : 'Automatic detection.';
  return `${method} Unconfirmed: verify the data layout and axis assignments against a matching definition.`;
}

export function filterMaps(maps: readonly MapDef[], filter: MapFilter): MapDef[] {
  const normalize = (s: string): string => s.toLowerCase().replace(/\s*[×x]\s*/g, 'x').trim();
  const query = normalize(filter.query);
  return maps.filter((m) => {
    const shape = isSwitch(m) ? 'switch' : isCurveShaped(m) ? 'curve' : 'grid';
    return (filter.shape === 'all' || shape === filter.shape) &&
      (filter.detector === 'all' || m.detector === filter.detector) &&
      normalize(`${m.name} 0x${m.address.toString(16)} ${m.rows}x${m.cols}`).includes(query);
  });
}
