import { describe, expect, it } from 'vitest';
import type { FamilyChecksums } from '@binanalyzer/families';
import { guarded, loadFamilyModule } from '../src/lib/familyloader.js';

const good = `
return {
  familyId: 'ms42',
  applies: (b) => b.length === 16,
  identify: () => undefined,
  verify: (b) => ({ familyId: 'ms42', applies: true, blocks: [], valid: false, skipped: [], notes: [] }),
  correct: (b) => ({ bytes: b, report: { familyId: 'ms42', applies: true, blocks: [], valid: false, skipped: [], notes: [] }, changed: [] }),
};`;

const err = (src: string): string => {
  const r = loadFamilyModule(src);
  return r.ok ? '(unexpectedly ok)' : r.error;
};

describe('loadFamilyModule', () => {
  it('evaluates a module and returns the family', () => {
    const r = loadFamilyModule(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.familyId).toBe('ms42');
    expect(r.value.applies(new Uint8Array(16))).toBe(true);
  });

  it('gives the module crc16, so it need not reimplement it', () => {
    const r = loadFamilyModule(
      `return { familyId: 'x', applies: () => bin.crc16(new Uint8Array([1,2,3]), 0) === bin.crc16(new Uint8Array([1,2,3]), 0), identify: () => undefined, verify: () => ({}), correct: (b) => ({}) };`
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.applies(new Uint8Array(0))).toBe(true);
  });

  it('reports a syntax error instead of throwing', () => {
    expect(err('return {')).toMatch(/syntax|unexpected/i);
  });

  it('reports a module that throws while loading', () => {
    expect(err(`throw new Error('boom');`)).toContain('boom');
  });

  it('rejects a file that returns nothing', () => {
    expect(err('const x = 1;')).toMatch(/did not return/i);
  });

  it('rejects a file that returns a non-object', () => {
    expect(err('return 42;')).toMatch(/did not return/i);
  });

  it('names the member that is missing', () => {
    expect(err(`return { familyId: 'ms42', applies: () => false };`)).toContain('identify');
  });

  it('rejects an empty familyId', () => {
    expect(
      err(
        `return { familyId: '', applies: () => false, identify: () => undefined, verify: () => ({}), correct: () => ({}) };`
      )
    ).toMatch(/familyId/);
  });
});

describe('guarded', () => {
  const throwing = (): FamilyChecksums => ({
    familyId: 'bad',
    applies: () => {
      throw new Error('applies exploded');
    },
    identify: () => {
      throw new Error('identify exploded');
    },
    verify: () => {
      throw new Error('verify exploded');
    },
    correct: () => {
      throw new Error('correct exploded');
    },
  });

  it('turns a throwing applies() into "does not apply"', () => {
    const errors: string[] = [];
    const g = guarded(throwing(), (e) => errors.push(e));
    expect(g.applies(new Uint8Array(4))).toBe(false);
    expect(errors[0]).toContain('applies exploded');
  });

  it('turns a throwing verify() into an inapplicable report, not a crash', () => {
    const g = guarded(throwing(), () => {});
    const r = g.verify(new Uint8Array(4));
    expect(r.applies).toBe(false);
    expect(r.valid).toBe(false);
    expect(r.notes.join(' ')).toMatch(/threw/i);
  });

  it('returns the input UNCHANGED when correct() throws — never a partial write', () => {
    const b = Uint8Array.from([1, 2, 3]);
    const g = guarded(throwing(), () => {});
    const out = g.correct(b);
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(out.changed).toEqual([]);
  });

  it('reports each failing member only ONCE, however often it is called', () => {
    const errors: string[] = [];
    const g = guarded(throwing(), (e) => errors.push(e));
    g.applies(new Uint8Array(4));
    g.applies(new Uint8Array(4));
    g.applies(new Uint8Array(4));
    expect(errors).toHaveLength(1);
  });

  it('leaves a well-behaved module alone', () => {
    const r = loadFamilyModule(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = guarded(r.value, () => {});
    expect(g.applies(new Uint8Array(16))).toBe(true);
  });
});
