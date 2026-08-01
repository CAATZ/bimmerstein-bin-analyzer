import { createHash } from 'node:crypto';
import { DEFAULT_SCAN_CONFIG } from '@binanalyzer/engine';

/**
 * MCP-adapter caps (2026-07-31 MCP spec §4.1/§5). These are page sizes, LRU
 * bounds and payload ceilings for the agent surface — NOT detection heuristics.
 * The "heuristic constants live only in packages/engine/src/config.ts" rule is
 * about detection tuning knobs; adapter caps are outside it, exactly as
 * apps/desktop's UI constants are. They are centralized here anyway.
 */
export const MCP_CONFIG = {
  /** Bins held resident; least-recently-used is evicted past this. */
  maxOpenBins: 4,
  /** Hard ceiling on a single bin (v1 spec §4 budgets 4 MB; 4x headroom). */
  maxBinBytes: 16 * 1024 * 1024,
  listMapsDefaultLimit: 50,
  listMapsMaxLimit: 200,
  listAxesDefaultLimit: 100,
  listAxesMaxLimit: 500,
  /** A 64x64 grid. Real MS41 tables never exceed 20 columns. */
  readMapMaxCells: 4096,
  readBytesDefaultLength: 256,
  readBytesMaxLength: 4096,
  readBytesDefaultCols: 16,
  maxRegionsReturned: 64,
  maxWarningsReturned: 50,
  importSampleSize: 5,
  /** ~ a full MS41 RomRaider definition. Over this, demand outPath. */
  exportMaxInlineChars: 200_000,
  /** Evicted bins remembered (path only) so an unknown-binId error can help. */
  evictionMemory: 16,
} as const;

/**
 * Scan-cache key component (spec §3.5, decision record D7): the engine's
 * DEFAULT config identity, never a caller input — v1 exposes no ScanConfig knob.
 * node:crypto is a built-in; @noble/hashes belongs to core and is not a
 * dependency of this package.
 */
export const CONFIG_VERSION: string = createHash('sha256')
  .update(JSON.stringify(DEFAULT_SCAN_CONFIG))
  .digest('hex')
  .slice(0, 16);
