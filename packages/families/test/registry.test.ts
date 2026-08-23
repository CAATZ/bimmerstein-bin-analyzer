import { describe, expect, it } from 'vitest';
import { FAMILY_IDS, familyCoverageGaps } from '@binanalyzer/core';
import { FAMILY_CHECKSUMS, checksumsFor } from '../src/index.js';
import type { FamilyChecksums } from '../src/types.js';
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

describe('a family id is not limited to the built-in union', () => {
  it('accepts a module whose id core never declared', () => {
    // The whole point of a drop-in module: `FAMILY_IDS` lists what SHIPS, not
    // what may exist. A module for an ECU we have never heard of must typecheck.
    const mod: FamilyChecksums = {
      familyId: 'ms42',
      applies: () => false,
      identify: () => undefined,
      verify: () => ({ familyId: 'ms42', applies: false, blocks: [], valid: false, skipped: [], notes: [] }),
      correct: (b) => ({ bytes: b, report: { familyId: 'ms42', applies: false, blocks: [], valid: false, skipped: [], notes: [] }, changed: [] }),
    };
    expect(mod.familyId).toBe('ms42');
  });
});
