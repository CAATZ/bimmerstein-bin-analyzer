import type { MapDef } from '@binanalyzer/core';
import type { PrefixedAxis, ScanResult } from '@binanalyzer/engine';
import { MCP_CONFIG } from './config.js';

export interface CachedScan {
  /** CONFIG_VERSION at the time of the scan; a mismatch invalidates the cache. */
  configVersion: string;
  result: ScanResult;
  durationMs: number;
}

export interface ImportedDefs {
  romId: string;
  maps: MapDef[];
  warnings: string[];
  frameApplied: 'sa->fo' | 'none';
}

/**
 * One resident bin. `bytes` is immutable by convention: v1 is read-only and
 * nothing in this server writes a bin byte. `path` is provenance only — the
 * file is never reopened.
 */
export interface OpenBin {
  binId: string;
  sha256: string;
  name: string;
  path: string;
  size: number;
  isFullRead: boolean;
  /**
   * What VALUE reads see. In co-pilot mode this is the app's WORKING buffer;
   * in headless mode it is the same reference as `originalBytes`.
   */
  bytes: Uint8Array;
  /**
   * The file as opened. DETECTION reads this and nothing else (Part C §3.5):
   * P4's "same bytes -> byte-identical maps with the same ids" premise breaks
   * the moment a scan sees edited bytes.
   */
  originalBytes: Uint8Array;
  /** sha256(bytes). Equals binId exactly while the session is clean. */
  contentSha256: string;
  /** How many bytes differ from the file as opened; always 0 in headless mode. */
  changedBytes: number;
  scan?: CachedScan;
  imported?: ImportedDefs;
  detectedAxes?: PrefixedAxis[];
  /**
   * The app's CONFIRMED maps, co-pilot mode only (spec §5.3). Headless mode
   * never sets it — there is no "confirmed" set in a private sandbox — and
   * headless list_maps does not offer that source.
   */
  confirmed?: MapDef[];
}

export interface OpenResult {
  entry: OpenBin;
  alreadyOpen: boolean;
  evicted: OpenBin[];
}

/**
 * The buffer a tool should read. Value reads take 'working' (the default);
 * DETECTION takes 'original' (Part C §3.5).
 *
 * Every read routes through here so that `originalBytes` itself stays confined
 * to the three files that declare or construct it, and so the guard test can
 * pin the two call sites that deliberately read pre-edit bytes.
 */
export function bufferFor(entry: OpenBin, which: 'working' | 'original'): Uint8Array {
  return which === 'original' ? entry.originalBytes : entry.bytes;
}

/**
 * Both buffers at once, for a consumer that DIFFS them rather than reading a
 * value out of one.
 *
 * This exists so the literal-'original' form of `bufferFor` can keep meaning
 * "detection, and nothing else" — spelled out rather than written as a call,
 * because the guard below scans raw text and a comment would trip it.
 * `list_edits` is not detection — it never scans and never
 * produces a MapDef — but it does need the pre-edit bytes to say what a value
 * WAS. Giving that access its own name, in the one module that already holds
 * `originalBytes`, keeps the literal-'original' guard precise instead of
 * widening it until it stops asserting anything.
 *
 * Call sites are pinned by test/buffer-guards.test.ts.
 */
export function diffPair(entry: OpenBin): { working: Uint8Array; original: Uint8Array } {
  return { working: entry.bytes, original: entry.originalBytes };
}

/**
 * The Phase-2 seam. Phase 1 owns bins in memory; the co-pilot implementation
 * (spec 2026-08-01-mcp-copilot-design.md) proxies to the live desktop store
 * over a loopback link, so every method is a round trip and the interface is
 * asynchronous. Tool surfaces DIFFER by mode — see that spec §8; the shared
 * contract is this interface plus binId === sha256.
 */
export interface SessionStore {
  open(entry: OpenBin): Promise<OpenResult>;
  get(binId: string): Promise<OpenBin | undefined>;
  list(): Promise<OpenBin[]>;
  setScan(binId: string, scan: CachedScan): Promise<void>;
  setImported(binId: string, imported: ImportedDefs): Promise<void>;
  setDetectedAxes(binId: string, axes: PrefixedAxis[]): Promise<void>;
  /** Path of a recently-evicted bin, so an unknown-id error can name it. */
  evictedPath(binId: string): Promise<string | undefined>;
}

export class MemorySessionStore implements SessionStore {
  /** Insertion order IS recency order: least-recently-used first. */
  private readonly entries = new Map<string, OpenBin>();
  private readonly evicted = new Map<string, string>();

  constructor(private readonly maxOpen: number = MCP_CONFIG.maxOpenBins) {}

  async open(entry: OpenBin): Promise<OpenResult> {
    const existing = this.entries.get(entry.binId);
    if (existing !== undefined) {
      this.touch(entry.binId);
      return { entry: existing, alreadyOpen: true, evicted: [] };
    }
    this.entries.set(entry.binId, entry);
    const evicted: OpenBin[] = [];
    while (this.entries.size > this.maxOpen) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      const dropped = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (dropped !== undefined) {
        evicted.push(dropped);
        this.remember(dropped);
      }
    }
    return { entry, alreadyOpen: false, evicted };
  }

  async get(binId: string): Promise<OpenBin | undefined> {
    const e = this.entries.get(binId);
    if (e === undefined) return undefined;
    this.touch(binId);
    return e;
  }

  async list(): Promise<OpenBin[]> {
    return [...this.entries.values()].reverse();
  }

  async setScan(binId: string, scan: CachedScan): Promise<void> {
    const e = this.entries.get(binId);
    if (e !== undefined) e.scan = scan;
  }

  async setImported(binId: string, imported: ImportedDefs): Promise<void> {
    const e = this.entries.get(binId);
    if (e !== undefined) e.imported = imported;
  }

  async setDetectedAxes(binId: string, axes: PrefixedAxis[]): Promise<void> {
    const e = this.entries.get(binId);
    if (e !== undefined) e.detectedAxes = axes;
  }

  async evictedPath(binId: string): Promise<string | undefined> {
    return this.evicted.get(binId);
  }

  private touch(binId: string): void {
    const e = this.entries.get(binId);
    if (e === undefined) return;
    this.entries.delete(binId);
    this.entries.set(binId, e);
  }

  private remember(dropped: OpenBin): void {
    this.evicted.set(dropped.binId, dropped.path);
    while (this.evicted.size > MCP_CONFIG.evictionMemory) {
      const oldest = this.evicted.keys().next();
      if (oldest.done === true) break;
      this.evicted.delete(oldest.value);
    }
  }
}
