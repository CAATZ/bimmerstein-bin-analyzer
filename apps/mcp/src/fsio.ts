import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Result } from '@binanalyzer/core';
import { MCP_CONFIG } from './config.js';

export interface BinRead {
  bytes: Uint8Array;
  name: string;
  resolvedPath: string;
}

/**
 * The ONLY module in this server that touches the filesystem. Bins are read
 * ONCE, read-only, and never reopened — v1's read-only invariant holds by
 * construction. writeText is reachable only through the write guard.
 */
export interface FileIo {
  readBin(path: string): Result<BinRead>;
  readText(path: string): Result<string>;
  writeText(path: string, text: string): Result<number>;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class NodeFileIo implements FileIo {
  readBin(path: string): Result<BinRead> {
    const resolved = resolve(path);
    let size: number;
    try {
      const st = statSync(resolved);
      if (!st.isFile()) return { ok: false, error: `"${resolved}" is not a regular file` };
      size = st.size;
    } catch (e) {
      return { ok: false, error: `cannot stat "${resolved}": ${message(e)}` };
    }
    if (size === 0) return { ok: false, error: `"${resolved}" is empty` };
    if (size > MCP_CONFIG.maxBinBytes) {
      return { ok: false, error: `"${resolved}" is ${size} bytes; this server caps a bin at ${MCP_CONFIG.maxBinBytes} bytes` };
    }
    try {
      return { ok: true, value: { bytes: new Uint8Array(readFileSync(resolved)), name: basename(resolved), resolvedPath: resolved } };
    } catch (e) {
      return { ok: false, error: `cannot read "${resolved}": ${message(e)}` };
    }
  }

  readText(path: string): Result<string> {
    const resolved = resolve(path);
    try {
      return { ok: true, value: readFileSync(resolved, 'utf8') };
    } catch (e) {
      return { ok: false, error: `cannot read "${resolved}": ${message(e)}` };
    }
  }

  writeText(path: string, text: string): Result<number> {
    try {
      writeFileSync(path, text, 'utf8');
      return { ok: true, value: Buffer.byteLength(text, 'utf8') };
    } catch (e) {
      return { ok: false, error: `cannot write "${path}": ${message(e)}` };
    }
  }
}
