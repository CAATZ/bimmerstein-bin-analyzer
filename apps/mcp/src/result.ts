import type { Result } from '@binanalyzer/core';
import type { SessionStore } from './session.js';
import type { Scanner } from './scanner.js';
import type { FileIo } from './fsio.js';
import type { CoPilotLink } from './link/server.js';
import type { RequestTable } from './requests.js';

/**
 * A `type` alias, deliberately NOT an interface: the SDK's CallToolResult is a
 * passthrough object (`[x: string]: unknown`), and TypeScript only grants an
 * implicit index signature to type aliases, not to interfaces. As an interface
 * this shape fails to satisfy setRequestHandler's return type even though it is
 * structurally identical.
 */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

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
  /** Co-pilot mode only (--copilot). */
  link?: CoPilotLink;
  /** Co-pilot mode only (--copilot). */
  requests?: RequestTable;
}

/** Uniform "we are not attached" error for every co-pilot-only tool. */
export function requireLink(deps: Deps): Result<CoPilotLink> {
  if (deps.link === undefined) {
    return {
      ok: false,
      error: 'this server is running in headless mode — restart it with --copilot to attach to the app',
    };
  }
  if (!deps.link.connected()) {
    return {
      ok: false,
      error: 'the desktop app is not connected — ask the user to enable "Share session with co-pilot" in the app',
    };
  }
  return { ok: true, value: deps.link };
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
export async function unknownBin(deps: Deps, binId: string): Promise<ToolResult> {
  const path = await deps.store.evictedPath(binId);
  const open = (await deps.store.list()).map((e) => e.binId);
  return err(
    path !== undefined
      ? `unknown binId "${binId}" — it was evicted (bounded LRU). Call open_bin again with path "${path}".`
      : `unknown binId "${binId}". Open bins: ${open.length > 0 ? open.join(', ') : '(none)'}. Call open_bin first, or list_bins to see what is resident.`
  );
}
