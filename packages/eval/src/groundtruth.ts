import type { MapDef, Result } from '@binanalyzer/core';

/**
 * Ground-truth format (spec §5): per-fixture groundtruth.json listing known
 * maps. For MS41 fixtures this is GENERATED from RomRaider definition XML via
 * @binanalyzer/formats importRomRaiderXml through the `gt-from-romraider`
 * CLI subcommand (see ./gt-from-romraider.ts).
 */
export interface GroundTruth {
  fixture: string;
  binSha256: string;
  maps: MapDef[]; // provenance 'imported'
}

export function parseGroundTruth(json: string): Result<GroundTruth> {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const d = doc as Partial<GroundTruth>;
  if (typeof d.fixture !== 'string' || d.fixture.length === 0) return { ok: false, error: 'missing fixture name' };
  if (typeof d.binSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.binSha256)) {
    return { ok: false, error: 'binSha256 must be 64 lowercase hex chars' };
  }
  if (!Array.isArray(d.maps)) return { ok: false, error: 'maps must be an array' };
  for (const [i, m] of d.maps.entries()) {
    const map = m as Partial<MapDef>;
    if (
      typeof map.address !== 'number' || typeof map.rows !== 'number' || typeof map.cols !== 'number' ||
      !map.format || typeof map.format.width !== 'number' || typeof map.id !== 'string'
    ) {
      return { ok: false, error: `maps[${i}] missing required fields (id, address, rows, cols, format.width)` };
    }
  }
  return { ok: true, value: { fixture: d.fixture, binSha256: d.binSha256, maps: d.maps as MapDef[] } };
}
