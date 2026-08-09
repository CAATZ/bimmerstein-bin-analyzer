import { describe, expect, it } from 'vitest';
import { FAMILY_IDS } from '@binanalyzer/core';
import { FAMILY_CHECKSUMS, checksumsFor } from '../src/index.js';
import { FULL, ms41Image } from './fixture.js';

const CHECKSUMS_NOT_IMPLEMENTED: readonly string[] = [];

describe('family coverage (checksum side)', () => {
  it('every FamilyId has a checksum module or an explicit opt-out', () => {
    const have = new Set(FAMILY_CHECKSUMS.map((c) => c.familyId));
    const missing = FAMILY_IDS.filter(
      (id) => !have.has(id) && !CHECKSUMS_NOT_IMPLEMENTED.includes(id)
    );
    expect(missing).toEqual([]);
  });

  it('no module exists for an id core does not declare', () => {
    const declared = new Set<string>(FAMILY_IDS);
    expect(FAMILY_CHECKSUMS.map((c) => c.familyId).filter((id) => !declared.has(id))).toEqual([]);
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
