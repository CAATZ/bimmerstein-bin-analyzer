import { MCP_CONFIG } from '../config.js';
import { ok, type ToolSpec } from '../result.js';

export const listBinsTool: ToolSpec = {
  name: 'list_bins',
  description:
    'List the bins currently resident in this server, most-recently-used first. Use it to recover a binId you lost, and to see which bins have been scanned or carry an imported definition. Bins are held in a bounded LRU; the least-recently-used is evicted silently.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handle(_raw, deps) {
    return ok({
      maxOpenBins: MCP_CONFIG.maxOpenBins,
      bins: (await deps.store.list()).map((e) => ({
        binId: e.binId,
        sha256: e.sha256,
        name: e.name,
        path: e.path,
        size: e.size,
        isFullRead: e.isFullRead,
        scanned: e.scan !== undefined,
        importedMaps: e.imported?.maps.length ?? 0,
      })),
    });
  },
};
