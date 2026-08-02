import { DEFAULT_SCAN_CONFIG, scanPrefixedAxes } from '@binanalyzer/engine';
import { MCP_CONFIG } from '../config.js';
import { asArgs, optAddress, optBool, optInt, reqString } from '../args.js';
import { err, ok, unknownBin, type ToolSpec } from '../result.js';

export const listDetectedAxesTool: ToolSpec = {
  name: 'list_detected_axes',
  description:
    'List count-prefixed axis runs found in the bin — the "detected axes" the Siemens MS4x cal layout stores as [count][cell…] and shares across many tables. Useful for finding a table when you know its axis, and for judging whether an ad-hoc read_map guess has real axes behind it. Independent of scan_bin: it always sweeps the whole file as one data region, so the answer never depends on session state.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['binId'],
    properties: {
      binId: { type: 'string', description: 'sha256 handle from open_bin.' },
      minCount: { type: 'integer', minimum: 1 },
      maxCount: { type: 'integer', minimum: 1 },
      maximalOnly: {
        type: 'boolean',
        default: true,
        description: 'Keep only runs whose monotone trend BREAKS at the declared length — the precision filter pool binding uses. false includes runs that keep ascending past their count.',
      },
      addressMin: { type: ['integer', 'string'], description: 'File offset of the first CELL, inclusive.' },
      addressMax: { type: ['integer', 'string'], description: 'EXCLUSIVE.' },
      offset: { type: 'integer', minimum: 0, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: MCP_CONFIG.listAxesMaxLimit, default: MCP_CONFIG.listAxesDefaultLimit },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const id = reqString(a, 'binId');
    if (!id.ok) return err(id.error);
    const minCount = optInt(a, 'minCount', 0, 0, Number.MAX_SAFE_INTEGER);
    if (!minCount.ok) return err(minCount.error);
    const maxCount = optInt(a, 'maxCount', 0, 0, Number.MAX_SAFE_INTEGER);
    if (!maxCount.ok) return err(maxCount.error);
    const maximalOnly = optBool(a, 'maximalOnly', true);
    if (!maximalOnly.ok) return err(maximalOnly.error);
    const addressMin = optAddress(a, 'addressMin');
    if (!addressMin.ok) return err(addressMin.error);
    const addressMax = optAddress(a, 'addressMax');
    if (!addressMax.ok) return err(addressMax.error);
    const offset = optInt(a, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    if (!offset.ok) return err(offset.error);
    const limit = optInt(a, 'limit', MCP_CONFIG.listAxesDefaultLimit, 1, MCP_CONFIG.listAxesMaxLimit);
    if (!limit.ok) return err(limit.error);

    const entry = await deps.store.get(id.value);
    if (entry === undefined) return await unknownBin(deps, id.value);

    // Synthetic full-range data region — the AxisLibraryDialog precedent. A
    // single bounded main-thread pass (the lib/snap.ts precedent); memoized
    // per bin because the input is fixed.
    let pool = entry.detectedAxes;
    if (pool === undefined) {
      pool = scanPrefixedAxes(entry.bytes, [{ start: 0, end: entry.size, kind: 'data' }], DEFAULT_SCAN_CONFIG);
      await deps.store.setDetectedAxes(entry.binId, pool);
    }

    const filtered = pool
      .filter((p) => {
        if (maximalOnly.value && !p.maximal) return false;
        if (minCount.value > 0 && p.count < minCount.value) return false;
        if (maxCount.value > 0 && p.count > maxCount.value) return false;
        if (addressMin.value !== undefined && p.address < addressMin.value) return false;
        if (addressMax.value !== undefined && p.address >= addressMax.value) return false;
        return true;
      })
      .sort((p, q) => p.address - q.address || p.count - q.count || p.format.width - q.format.width);

    const page = filtered.slice(offset.value, offset.value + limit.value);
    return ok({
      binId: entry.binId,
      total: filtered.length,
      offset: offset.value,
      limit: limit.value,
      returned: page.length,
      hasMore: offset.value + page.length < filtered.length,
      axes: page.map((p) => ({
        address: p.address,
        prefixAddress: p.address - p.format.width,
        count: p.count,
        end: p.end,
        format: p.format,
        maximal: p.maximal,
      })),
    });
  },
};
