import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkFilePath, mintToken, removeHandshake, writeHandshake } from '../src/link/handshake.js';

const norm = (p: string): string => p.replace(/\\/g, '/');

describe('linkFilePath', () => {
  it('uses LOCALAPPDATA on Windows', () => {
    const p = linkFilePath({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' }, 'win32', 'C:/Users/x');
    expect(norm(p)).toBe('C:/Users/x/AppData/Local/BimmerStein Bin Analyzer/copilot-link.json');
  });

  it('uses Application Support on macOS', () => {
    expect(norm(linkFilePath({}, 'darwin', '/Users/x')))
      .toBe('/Users/x/Library/Application Support/BimmerStein Bin Analyzer/copilot-link.json');
  });

  it('uses XDG_STATE_HOME on Linux, defaulting to ~/.local/state', () => {
    expect(norm(linkFilePath({ XDG_STATE_HOME: '/run/state' }, 'linux', '/home/x')))
      .toBe('/run/state/bimmerstein-bin-analyzer/copilot-link.json');
    expect(norm(linkFilePath({}, 'linux', '/home/x')))
      .toBe('/home/x/.local/state/bimmerstein-bin-analyzer/copilot-link.json');
  });
});

describe('mintToken', () => {
  it('is 64 hex chars and never repeats', () => {
    const a = mintToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(mintToken()).not.toBe(a);
  });
});

describe('writeHandshake / removeHandshake', () => {
  it('writes the record, creates missing parents, and deletes it again', () => {
    const at = join(mkdtempSync(join(tmpdir(), 'bslink-')), 'nested', 'copilot-link.json');
    writeHandshake(51733, 'f'.repeat(64), at);
    const rec = JSON.parse(readFileSync(at, 'utf8'));
    expect(rec).toMatchObject({ v: 1, port: 51733, token: 'f'.repeat(64), pid: process.pid });
    expect(typeof rec.startedAt).toBe('string');
    if (process.platform !== 'win32') expect(statSync(at).mode & 0o777).toBe(0o600);
    removeHandshake(at);
    expect(existsSync(at)).toBe(false);
  });

  it('removing a file that is not there is not an error', () => {
    expect(() => removeHandshake(join(tmpdir(), 'bslink-absent', 'copilot-link.json'))).not.toThrow();
  });
});
