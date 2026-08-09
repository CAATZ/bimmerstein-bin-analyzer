import { describe, expect, it } from 'vitest';
import { FAMILY_IDS } from '@binanalyzer/core';
import { FAMILY_ANALYZERS } from '../src/family/index.js';

/**
 * Families are described in TWO packages: detection here, byte semantics in
 * packages/families. Neither may import the other, so drift is caught by each
 * side testing itself against core's FAMILY_IDS. Adding an id fails both
 * suites until both halves exist or explicitly opt out.
 */
const DETECTION_NOT_IMPLEMENTED: readonly string[] = [];

describe('family coverage (detection side)', () => {
  it('every FamilyId has an analyzer or an explicit opt-out', () => {
    const analyzers = new Set(FAMILY_ANALYZERS.map((a) => a.id));
    const missing = FAMILY_IDS.filter(
      (id) => !analyzers.has(id) && !DETECTION_NOT_IMPLEMENTED.includes(id)
    );
    expect(missing).toEqual([]);
  });

  it('no analyzer exists for an id core does not declare', () => {
    const declared = new Set<string>(FAMILY_IDS);
    expect(FAMILY_ANALYZERS.map((a) => a.id).filter((id) => !declared.has(id))).toEqual([]);
  });
});
