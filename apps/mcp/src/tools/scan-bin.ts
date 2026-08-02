import type { Region, ScanResult } from '@binanalyzer/engine';
import { CONFIG_VERSION, MCP_CONFIG } from '../config.js';
import { asArgs, optBool, reqString } from '../args.js';
import { mapKind } from '../kind.js';
import { err, ok, unknownBin, type ToolSpec } from '../result.js';

function regionSummary(regions: Region[]): Record<string, { count: number; bytes: number }> {
  const out: Record<string, { count: number; bytes: number }> = {};
  for (const r of regions) {
    const slot = out[r.kind] ?? { count: 0, bytes: 0 };
    slot.count += 1;
    slot.bytes += r.end - r.start;
    out[r.kind] = slot;
  }
  return out;
}

export const scanBinTool: ToolSpec = {
  name: 'scan_bin',
  description:
    'Run the full detection pipeline over an open bin and return a SUMMARY ONLY: counts by shape kind and detector tier, the confidence spread, and the region map. It never returns the map list — a 256 KB MS41 full read emits about 4,600 potential maps. Enumerate them with list_maps, which is paginated and filtered. The result is cached; the engine is deterministic, so a re-scan of the same bytes cannot differ.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['binId'],
    properties: {
      binId: { type: 'string', description: 'sha256 handle from open_bin.' },
      force: {
        type: 'boolean',
        default: false,
        description: 'Recompute instead of serving the cache. The engine is deterministic, so this changes nothing unless the engine itself changed.',
      },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const id = reqString(a, 'binId');
    if (!id.ok) return err(id.error);
    const force = optBool(a, 'force', false);
    if (!force.ok) return err(force.error);

    const entry = await deps.store.get(id.value);
    if (entry === undefined) return await unknownBin(deps, id.value);

    let cached = true;
    let record = entry.scan;
    if (record === undefined || record.configVersion !== CONFIG_VERSION || force.value) {
      const started = Date.now();
      let result: ScanResult;
      try {
        result = await deps.scanner.scan(entry.bytes);
      } catch (e) {
        return err(`scan failed for "${entry.name}": ${e instanceof Error ? e.message : String(e)}`);
      }
      record = { configVersion: CONFIG_VERSION, result, durationMs: Date.now() - started };
      await deps.store.setScan(entry.binId, record);
      cached = false;
    }

    const maps = record.result.potentialMaps;
    const byKind = { grid: 0, curve: 0, switch: 0, param: 0 };
    const byDetector = { family: 0, structural: 0, pool: 0, generic: 0, none: 0 };
    for (const m of maps) {
      byKind[mapKind(m)] += 1;
      byDetector[m.detector ?? 'none'] += 1;
    }
    const confidences = maps.map((m) => m.confidence ?? 0).sort((x, y) => x - y);
    const regions = record.result.regions;
    const tooManyRegions = regions.length > MCP_CONFIG.maxRegionsReturned;

    return ok({
      binId: entry.binId,
      cached,
      durationMs: cached ? 0 : record.durationMs,
      potentialMapCount: maps.length,
      byKind,
      byDetector,
      byConfidence:
        confidences.length === 0
          ? null
          : {
              min: confidences[0],
              median: confidences[Math.floor(confidences.length / 2)],
              max: confidences[confidences.length - 1],
            },
      regionSummary: regionSummary(regions),
      ...(tooManyRegions
        ? { regionsTruncated: true, regionCount: regions.length }
        : { regions: regions.map((r) => ({ start: r.start, end: r.end, kind: r.kind })) }),
    });
  },
};
