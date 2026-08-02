import { describe, expect, it } from 'vitest';
import { parseArgv, USAGE } from '../src/argv.js';

describe('parseArgv', () => {
  it('defaults to no write root', () => {
    expect(parseArgv([])).toEqual({ ok: true, value: { copilot: false } });
  });

  it('accepts --allow-write in both spellings', () => {
    expect(parseArgv(['--allow-write', '/out'])).toEqual({ ok: true, value: { writeRoot: '/out', copilot: false } });
    expect(parseArgv(['--allow-write=/out'])).toEqual({ ok: true, value: { writeRoot: '/out', copilot: false } });
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

describe('parseArgv --copilot', () => {
  it('selects co-pilot mode; the default is headless', () => {
    const a = parseArgv(['--copilot']);
    expect(a.ok && a.value.copilot).toBe(true);
    const b = parseArgv([]);
    expect(b.ok && b.value.copilot).toBe(false);
  });

  it('composes with --allow-write', () => {
    const r = parseArgv(['--copilot', '--allow-write', 'C:/out']);
    expect(r.ok && r.value).toMatchObject({ copilot: true, writeRoot: 'C:/out' });
  });

  it('is named in the usage text', () => {
    expect(USAGE).toContain('--copilot');
  });
});
