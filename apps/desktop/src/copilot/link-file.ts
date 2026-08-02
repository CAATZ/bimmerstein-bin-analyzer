import { PROTOCOL_VERSION } from './protocol.js';
import type { PlatformHost } from '../platform/host.js';

export type OsKind = 'windows' | 'macos' | 'linux';

export interface OsPaths {
  home: string;
  localAppData?: string;
  xdgStateHome?: string;
}

/**
 * MUST stay identical to apps/mcp/src/link/handshake.ts linkFilePath(). Both
 * ends compute it; neither configures it. If one moves, both move.
 */
export function linkFilePathFor(os: OsKind, paths: OsPaths): string {
  if (os === 'windows') {
    const base = paths.localAppData ?? `${paths.home}/AppData/Local`;
    return `${base}/BimmerStein Bin Analyzer/copilot-link.json`;
  }
  if (os === 'macos') {
    return `${paths.home}/Library/Application Support/BimmerStein Bin Analyzer/copilot-link.json`;
  }
  const base = paths.xdgStateHome ?? `${paths.home}/.local/state`;
  return `${base}/bimmerstein-bin-analyzer/copilot-link.json`;
}

/**
 * Re-read on every dial attempt: a restarted server writes a new port and a new
 * token, and a stale file left by a crash must simply fail to connect.
 */
export function makeReadLink(
  host: PlatformHost,
  path: () => string
): () => Promise<{ port: number; token: string } | null> {
  return async () => {
    let text: string | null;
    try {
      text = await host.readTextIfExists(path());
    } catch {
      return null;
    }
    if (text === null) return null;
    try {
      const rec = JSON.parse(text) as Record<string, unknown>;
      if (rec['v'] !== PROTOCOL_VERSION) return null;
      if (typeof rec['port'] !== 'number' || typeof rec['token'] !== 'string') return null;
      return { port: rec['port'], token: rec['token'] };
    } catch {
      return null;
    }
  };
}
