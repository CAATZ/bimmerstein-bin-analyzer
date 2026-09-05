import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveWriteTarget } from '../src/writeguard.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

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

  it('accepts a filename beginning with two dots inside the granted root', () => {
    expect(resolveWriteTarget(root, join(root, '..definition.xml')).ok).toBe(true);
  });

  it('refuses an existing file symlink that points outside the granted root', (ctx) => {
    const target = join(outside, 'definition.xml');
    const link = join(root, 'definition-link.xml');
    writeFileSync(target, 'original');
    try {
      symlinkSync(target, link, 'file');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw e;
    }
    expect(resolveWriteTarget(root, link).ok).toBe(false);
  });

  it('checks the resolved existing filename as well as its parent', () => {
    const link = join(root, 'resolved-definition.xml');
    const target = join(outside, 'resolved-definition.xml');
    writeFileSync(link, 'original');
    writeFileSync(target, 'outside');
    const realRoot = fs.realpathSync(root);
    const resolver = vi.spyOn(fs, 'realpathSync')
      .mockReturnValueOnce(realRoot)
      .mockReturnValueOnce(realRoot)
      .mockReturnValue(target);
    try {
      const result = resolveWriteTarget(root, link);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('outside');
    } finally {
      resolver.mockRestore();
    }
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
