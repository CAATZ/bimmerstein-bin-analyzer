import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Result } from '@binanalyzer/core';

/**
 * The ONLY gate to a write in this server (2026-07-31 MCP spec §5.10,
 * decision record D3). All of these must hold:
 *   1. the server was started with --allow-write <dir>
 *   2. that root resolves to an existing directory
 *   3. the target's parent directory resolves, and the REAL resolved target is
 *      inside the REAL root — compared with path.relative, not string
 *      startsWith, so "<root>evil" cannot pass for "<root>"
 *   4. the target is not an existing directory
 * Symlinks are resolved first, so `..` and link escapes both fail.
 * Bin bytes are never written under any configuration — only definition
 * exports reach this function.
 */
export function resolveWriteTarget(root: string | undefined, outPath: string): Result<string> {
  if (root === undefined) {
    return { ok: false, error: '"outPath" was given but this server was started without --allow-write <dir>. Omit outPath to get the definition back as text, or restart the server with a granted directory.' };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
    if (!statSync(realRoot).isDirectory()) return { ok: false, error: `--allow-write root "${root}" is not a directory` };
  } catch {
    return { ok: false, error: `--allow-write root "${root}" does not exist` };
  }

  const absolute = resolve(outPath);
  let realParent: string;
  try {
    realParent = realpathSync(dirname(absolute));
  } catch {
    return { ok: false, error: `the directory of "${outPath}" does not exist — create it first (this server does not create directories)` };
  }
  const target = join(realParent, basename(absolute));

  const rel = relative(realRoot, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `"${outPath}" resolves to "${target}", which is outside the granted --allow-write root "${realRoot}"` };
  }
  if (existsSync(target) && statSync(target).isDirectory()) {
    return { ok: false, error: `"${target}" is an existing directory` };
  }
  return { ok: true, value: target };
}
