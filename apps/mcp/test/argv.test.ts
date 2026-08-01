import { describe, expect, it } from 'vitest';
import { parseArgv, USAGE } from '../src/argv.js';

describe('parseArgv', () => {
  it('defaults to no write root', () => {
    expect(parseArgv([])).toEqual({ ok: true, value: {} });
  });

  it('accepts --allow-write in both spellings', () => {
    expect(parseArgv(['--allow-write', '/out'])).toEqual({ ok: true, value: { writeRoot: '/out' } });
    expect(parseArgv(['--allow-write=/out'])).toEqual({ ok: true, value: { writeRoot: '/out' } });
  });

  it('rejects --allow-write without a directory', () => {
    const r = parseArgv(['--allow-write']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--allow-write');
  });

  it('rejects an unknown flag and shows usage', () => {
    const r = parseArgv(['--nope']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--nope');
    expect(USAGE).toContain('--allow-write');
  });
});
