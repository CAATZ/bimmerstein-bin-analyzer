import { describe, expect, it } from 'vitest';
import { FAMILY_IDS, familyCoverageGaps } from '@binanalyzer/core';
import { FAMILY_ANALYZERS } from '../src/family/index.js';

/**
 * Families are described in TWO packages: detection here, byte semantics in
 * packages/families. Neither may import the other, so drift is caught by each
 * side testing itself against core's FAMILY_IDS. Adding an id fails both
 * suites until both halves exist or explicitly opt out.
 *
 * The rule itself lives in core and is exercised there against lists that
 * disagree — with one declared family this side can only ever feed it agreeing
 * lists, so it could not tell a working rule from an inverted one.
 */
const DETECTION_NOT_IMPLEMENTED: readonly string[] = [];

describe('family coverage (detection side)', () => {
  it('every FamilyId has an analyzer, and no analyzer claims an undeclared id', () => {
    expect(
      familyCoverageGaps(
        FAMILY_IDS,
        FAMILY_ANALYZERS.map((a) => a.id),
        DETECTION_NOT_IMPLEMENTED
      )
    ).toEqual({ missing: [], undeclared: [] });
  });
});
