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
  /**
   * Inline export ceiling. Over this, demand outPath rather than return a
   * truncated definition. Sized from MEASURED exports of the real 306-map MS41
   * definition (2026-08-01): RomRaider 177,298 · JSON 150,420 · CSV 38,728 —
   * so 400k gives the largest realistic definition ~2.3x headroom. It still
   * refuses the payloads that would destroy an agent's context: the same 306
   * maps as XDF are 636,231 chars (XDF is ~3.6x RomRaider — embedded axis data
   * plus a per-table equation), and a 4,616-map potential-map dump is 442,810
   * as CSV and 2,099,498 as JSON. Those two ranges OVERLAP, so no single cap
   * separates "a real definition" from "a firehose" — this one is set by what
   * fits in a reply, not by intent.
   */
  exportMaxInlineChars: 400_000,
  /** Evicted bins remembered (path only) so an unknown-binId error can help. */
  evictionMemory: 16,
  /**
   * Co-pilot mode: how long a Point/Change op may wait for the app before it is
   * reported as unanswered. Deliberately short — these are local, synchronous UI
   * actions (measured link RTT p50 0.2 ms). Deferred USER decisions do not use
   * this path; they go through the RequestTable and never block a tool call.
   */
  linkRequestTimeoutMs: 5_000,
  /** Deferred user decisions remembered, so an agent can still poll an old one. */
  maxTrackedRequests: 32,
  /**
   * Ceiling on one proposal. A guard, not a target: the real MS41 definition is
   * 306 maps. Past this, something has gone wrong upstream.
   */
  maxProposedChanges: 2_000,
  /**
   * Ceiling on one value-edit proposal. Pinned to the same number as
   * readMapMaxCells on principle, not coincidence: expectedRaw is required, so
   * an agent must READ a cell before it may propose writing it, and it cannot
   * legitimately author more cells in one batch than a single read_map hands
   * it. Real MS41 tables never exceed 20 columns.
   */
  maxProposedEdits: 4_096,
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
