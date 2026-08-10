import { describe, expect, it } from 'vitest';
import { FAMILY_IDS, familyCoverageGaps } from '../src/index.js';

/**
 * The rule itself, driven with lists that DISAGREE.
 *
 * The two registry suites that use it (engine's analyzers, families' checksum
 * modules) can only ever feed it agreeing lists while one family is declared,
 * so neither can tell a working rule from an inverted one. These cases can.
 */
describe('familyCoverageGaps', () => {
  it('reports an id that is declared but has no implementation', () => {
    expect(familyCoverageGaps(['ms41', 'ms43'], ['ms41'])).toEqual({
      missing: ['ms43'],
      undeclared: [],
    });
  });

  it('an explicit opt-out silences that id, and only that id', () => {
    expect(familyCoverageGaps(['ms41', 'ms43', 'me7'], ['ms41'], ['ms43'])).toEqual({
      missing: ['me7'],
      undeclared: [],
    });
  });

  it('reports an implementation for an id core never declared', () => {
    expect(familyCoverageGaps(['ms41'], ['ms41', 'ms43'])).toEqual({
      missing: [],
      undeclared: ['ms43'],
    });
  });

  it('an opt-out does NOT excuse an undeclared implementation', () => {
    // Opting out means "core declares it, we have not built it yet" — it must
    // not become a way to smuggle in a module for an id core does not know.
    expect(familyCoverageGaps(['ms41'], ['ms41', 'ms43'], ['ms43'])).toEqual({
      missing: [],
      undeclared: ['ms43'],
    });
  });

  it('is empty when the two lists agree', () => {
    expect(familyCoverageGaps(['ms41'], ['ms41'])).toEqual({ missing: [], undeclared: [] });
  });

  it('holds for the real declared list', () => {
    expect(familyCoverageGaps(FAMILY_IDS, [...FAMILY_IDS])).toEqual({
      missing: [],
      undeclared: [],
    });
  });
});
