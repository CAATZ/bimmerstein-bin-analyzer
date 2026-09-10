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
 * File access for headless bins, definitions and guarded text exports.
 * There is no firmware-write operation. Connection handshake files are
 * managed separately by the link module.
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
