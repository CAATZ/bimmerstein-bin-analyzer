import { describe, expect, it } from 'vitest';
import { FAMILY_IDS, familyCoverageGaps } from '@binanalyzer/core';
import { FAMILY_CHECKSUMS, checksumsFor } from '../src/index.js';
import { FULL, ms41Image } from './fixture.js';

const CHECKSUMS_NOT_IMPLEMENTED: readonly string[] = [];

describe('family coverage (checksum side)', () => {
  // The rule lives in core and is exercised there against lists that disagree;
  // with one declared family this side can only ever feed it agreeing lists.
  it('every FamilyId has a checksum module, and no module claims an undeclared id', () => {
    expect(
      familyCoverageGaps(
        FAMILY_IDS,
        FAMILY_CHECKSUMS.map((c) => c.familyId),
        CHECKSUMS_NOT_IMPLEMENTED
      )
    ).toEqual({ missing: [], undeclared: [] });
  });
});

describe('checksumsFor', () => {
  it('selects the module that recognises the image', () => {
    expect(checksumsFor(ms41Image(FULL))?.familyId).toBe('ms41');
  });

  it('returns undefined for an unrecognised image', () => {
    expect(checksumsFor(new Uint8Array(4096))).toBeUndefined();
  });
});
