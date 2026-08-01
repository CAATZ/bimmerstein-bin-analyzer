import type { SessionStore } from './session.js';
import type { Scanner } from './scanner.js';
import type { FileIo } from './fsio.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

/**
 * Success payloads are COMPACT JSON (no indentation): a single list_maps page
 * is up to 200 rows off a 4,600-map bin, and token economy is a real design
 * constraint on this surface (2026-07-31 MCP spec §5).
 */
export const ok = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

export const err = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

export interface Deps {
  store: SessionStore;
  scanner: Scanner;
  io: FileIo;
  /** Set only when the server was started with --allow-write <dir>. */
  writeRoot?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /**
   * JSON Schema, always `{ type: 'object', … }`. Kept as a plain record so this
   * module stays free of SDK types; server.ts narrows it at the protocol
   * boundary, which is the only place the SDK's `Tool` shape matters.
   */
  inputSchema: Record<string, unknown>;
  handle(args: unknown, deps: Deps): Promise<ToolResult>;
}

/** Uniform unknown-binId error that names the evicted path when we have it. */
export function unknownBin(deps: Deps, binId: string): ToolResult {
  const path = deps.store.evictedPath(binId);
  const open = deps.store.list().map((e) => e.binId);
  return err(
    path !== undefined
      ? `unknown binId "${binId}" — it was evicted (bounded LRU). Call open_bin again with path "${path}".`
      : `unknown binId "${binId}". Open bins: ${open.length > 0 ? open.join(', ') : '(none)'}. Call open_bin first, or list_bins to see what is resident.`
  );
}
