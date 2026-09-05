import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROTOCOL_VERSION } from './envelope.js';

const APP_DIR = 'BimmerStein Bin Analyzer';
const FILE = 'copilot-link.json';

/**
 * Where the app looks for the live link. Both ends compute it; neither
 * configures it (2026-08-01-mcp-copilot-design.md §4.2). Parameters exist so
 * the resolution is testable without touching the real user profile.
 *
 * BIMMERSTEIN_LINK_FILE overrides the computed path. It exists for tests; the
 * app and the server agree on the computed path in normal use.
 */
export function linkFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  const override = env['BIMMERSTEIN_LINK_FILE'];
  if (override !== undefined && override !== '') return override;

  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    return join(base, APP_DIR, FILE);
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_DIR, FILE);
  }
  const base = env['XDG_STATE_HOME'] ?? join(home, '.local', 'state');
  return join(base, 'bimmerstein-bin-analyzer', FILE);
}

/** 32 bytes of CSPRNG, hex. Minted per server start, never reused, never logged. */
export function mintToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * NOT subject to the --allow-write guard, deliberately: that guard governs
 * export targets the AGENT names, and its invariant is "the agent cannot cause
 * a write to a path it chose". This path is fixed, computed from the OS,
 * carries no user data, and lives only as long as the process.
 */
export function writeHandshake(port: number, token: string, at: string = linkFilePath()): void {
  mkdirSync(dirname(at), { recursive: true });
  const record = {
    v: PROTOCOL_VERSION,
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    server: 'bimmerstein-mcp/0.2.0',
  };
  writeFileSync(at, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode is masked by umask, and does nothing when the file
  // already existed — chmod unconditionally so the token is never group/world
  // readable on a platform that enforces it.
  try {
    chmodSync(at, 0o600);
  } catch {
    /* Windows has no POSIX mode; the ACL is the user's own profile directory. */
  }
}

/** Idempotent: a missing file is the normal case after a crash. */
export function removeHandshake(at: string = linkFilePath()): void {
  rmSync(at, { force: true });
}
