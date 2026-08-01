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
  bytes: Uint8Array;
  scan?: CachedScan;
  imported?: ImportedDefs;
  detectedAxes?: PrefixedAxis[];
}

export interface OpenResult {
  entry: OpenBin;
  alreadyOpen: boolean;
  evicted: OpenBin[];
}

/**
 * The Phase-2 seam (decision record D6). Phase 1 owns bins in memory; a future
 * sidecar implementation proxies to the live desktop store. Tool schemas are
 * identical in both, so only this interface is implemented twice.
 */
export interface SessionStore {
  open(entry: OpenBin): OpenResult;
  get(binId: string): OpenBin | undefined;
  list(): OpenBin[];
  setScan(binId: string, scan: CachedScan): void;
  setImported(binId: string, imported: ImportedDefs): void;
  setDetectedAxes(binId: string, axes: PrefixedAxis[]): void;
  /** Path of a recently-evicted bin, so an unknown-id error can name it. */
  evictedPath(binId: string): string | undefined;
}

export class MemorySessionStore implements SessionStore {
  /** Insertion order IS recency order: least-recently-used first. */
  private readonly entries = new Map<string, OpenBin>();
  private readonly evicted = new Map<string, string>();

  constructor(private readonly maxOpen: number = MCP_CONFIG.maxOpenBins) {}

  open(entry: OpenBin): OpenResult {
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

  get(binId: string): OpenBin | undefined {
    const e = this.entries.get(binId);
    if (e === undefined) return undefined;
    this.touch(binId);
    return e;
  }

  list(): OpenBin[] {
    return [...this.entries.values()].reverse();
  }

  setScan(binId: string, scan: CachedScan): void {
    const e = this.entries.get(binId);
    if (e !== undefined) e.scan = scan;
  }

  setImported(binId: string, imported: ImportedDefs): void {
    const e = this.entries.get(binId);
    if (e !== undefined) e.imported = imported;
  }

  setDetectedAxes(binId: string, axes: PrefixedAxis[]): void {
    const e = this.entries.get(binId);
    if (e !== undefined) e.detectedAxes = axes;
  }

  evictedPath(binId: string): string | undefined {
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
