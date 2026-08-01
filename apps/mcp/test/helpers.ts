import type { Result } from '@binanalyzer/core';
import { InlineScanner } from '../src/scanner.js';
import { MemorySessionStore } from '../src/session.js';
import type { BinRead, FileIo } from '../src/fsio.js';
import type { Deps, ToolResult, ToolSpec } from '../src/result.js';

export class FakeFileIo implements FileIo {
  readonly written = new Map<string, string>();
  constructor(
    private readonly bins: Record<string, Uint8Array> = {},
    private readonly texts: Record<string, string> = {}
  ) {}

  readBin(path: string): Result<BinRead> {
    const bytes = this.bins[path];
    if (bytes === undefined) return { ok: false, error: `cannot stat "${path}": no such file` };
    const name = path.split(/[\\/]/).pop() ?? path;
    return { ok: true, value: { bytes, name, resolvedPath: path } };
  }

  readText(path: string): Result<string> {
    const text = this.texts[path];
    return text === undefined ? { ok: false, error: `cannot read "${path}": no such file` } : { ok: true, value: text };
  }

  writeText(path: string, text: string): Result<number> {
    this.written.set(path, text);
    return { ok: true, value: text.length };
  }
}

export function fakeDeps(over: Partial<Deps> & { bins?: Record<string, Uint8Array>; texts?: Record<string, string> } = {}): Deps & { io: FakeFileIo } {
  const io = (over.io as FakeFileIo | undefined) ?? new FakeFileIo(over.bins ?? {}, over.texts ?? {});
  return {
    store: over.store ?? new MemorySessionStore(4),
    scanner: over.scanner ?? new InlineScanner(),
    io,
    ...(over.writeRoot !== undefined ? { writeRoot: over.writeRoot } : {}),
  };
}

/** Parse a successful tool result's JSON payload. Throws on isError. */
export function payload<T = Record<string, unknown>>(r: ToolResult): T {
  if (r.isError === true) throw new Error(`tool errored: ${r.content[0]?.text ?? ''}`);
  return JSON.parse(r.content[0]?.text ?? 'null') as T;
}

export function errorText(r: ToolResult): string {
  if (r.isError !== true) throw new Error(`expected an error, got ${r.content[0]?.text ?? ''}`);
  return r.content[0]?.text ?? '';
}

export async function call(tool: ToolSpec, args: unknown, deps: Deps): Promise<ToolResult> {
  return tool.handle(args, deps);
}
