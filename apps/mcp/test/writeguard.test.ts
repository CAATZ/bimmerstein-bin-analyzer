import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveWriteTarget } from '../src/writeguard.js';

const root = mkdtempSync(join(tmpdir(), 'binmcp-root-'));
const outside = mkdtempSync(join(tmpdir(), 'binmcp-out-'));

describe('resolveWriteTarget', () => {
  it('refuses when no root was configured', () => {
    const r = resolveWriteTarget(undefined, join(root, 'x.xml'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--allow-write');
  });

  it('accepts a target directly inside the root', () => {
    const r = resolveWriteTarget(root, join(root, 'def.xml'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(resolve(root, 'def.xml'));
  });

  it('accepts a target in an existing sub-directory of the root', () => {
    mkdirSync(join(root, 'sub'), { recursive: true });
    expect(resolveWriteTarget(root, join(root, 'sub', 'def.xml')).ok).toBe(true);
  });

  it('refuses a target outside the root', () => {
    const r = resolveWriteTarget(root, join(outside, 'def.xml'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('outside');
  });

  it('refuses a .. escape', () => {
    expect(resolveWriteTarget(root, join(root, '..', 'escape.xml')).ok).toBe(false);
  });

  it('refuses a sibling whose name merely PREFIXES the root', () => {
    const sibling = `${root}evil`;
    mkdirSync(sibling, { recursive: true });
    expect(resolveWriteTarget(root, join(sibling, 'def.xml')).ok).toBe(false);
  });

  it('refuses when the target is an existing directory', () => {
    mkdirSync(join(root, 'adir'), { recursive: true });
    const r = resolveWriteTarget(root, join(root, 'adir'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('directory');
  });

  it('refuses when the parent directory does not exist', () => {
    expect(resolveWriteTarget(root, join(root, 'nodir', 'def.xml')).ok).toBe(false);
  });

  it('refuses when the configured root does not exist', () => {
    expect(resolveWriteTarget(join(root, 'ghost'), join(root, 'def.xml')).ok).toBe(false);
  });

  it('resolves symlinks before the containment check', () => {
    const link = join(root, 'link');
    try {
      symlinkSync(outside, link, 'dir');
    } catch {
      return; // symlink creation needs privileges on Windows; the case above covers plain escapes
    }
    writeFileSync(join(outside, 'marker'), 'x');
    expect(resolveWriteTarget(root, join(link, 'def.xml')).ok).toBe(false);
  });
});
