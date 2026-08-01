import type { Result } from '@binanalyzer/core';

export interface CliOptions {
  /** Only set by --allow-write; without it no write is ever attempted. */
  writeRoot?: string;
}

export const USAGE = `bimmerstein-mcp — BimmerStein Bin Analyzer MCP server (stdio)

Usage: node apps/mcp/bin/bimmerstein-mcp.mjs [--allow-write <dir>]

  --allow-write <dir>   Permit export_definition to write inside <dir> (and only
                        there, symlinks resolved). Without it, exports are
                        returned as text. Bin files are NEVER written.`;

export function parseArgv(argv: string[]): Result<CliOptions> {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--allow-write=')) {
      const value = arg.slice('--allow-write='.length);
      if (value.length === 0) return { ok: false, error: `--allow-write needs a directory\n\n${USAGE}` };
      options.writeRoot = value;
      continue;
    }
    if (arg === '--allow-write') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `--allow-write needs a directory\n\n${USAGE}` };
      options.writeRoot = value;
      i++;
      continue;
    }
    return { ok: false, error: `unknown argument "${arg}"\n\n${USAGE}` };
  }
  return { ok: true, value: options };
}
