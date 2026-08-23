import { beforeEach, describe, expect, it } from 'vitest';
import {
  checksumsFor,
  clearExternalFamilies,
  externalFamilies,
  registerExternalFamily,
  type FamilyChecksums,
} from '../src/index.js';
import { FULL, ms41Image } from './fixture.js';

const empty = (id: string) => ({
  familyId: id,
  applies: false as const,
  blocks: [],
  valid: false,
  skipped: [],
  notes: [],
});

const fake = (id: string, applies: (b: Uint8Array) => boolean): FamilyChecksums => ({
  familyId: id,
  applies,
  identify: () => undefined,
  verify: () => empty(id),
  correct: (b) => ({ bytes: b, report: empty(id), changed: [] }),
});

describe('external families', () => {
  beforeEach(() => clearExternalFamilies());

  it('starts empty and clears back to empty', () => {
    expect(externalFamilies()).toEqual([]);
    registerExternalFamily(fake('ms42', () => true));
    expect(externalFamilies()).toHaveLength(1);
    clearExternalFamilies();
    expect(externalFamilies()).toEqual([]);
  });

  it('is found by checksumsFor when no built-in claims the image', () => {
    const buf = new Uint8Array(16);
    expect(checksumsFor(buf)).toBeUndefined();
    registerExternalFamily(fake('ms42', (b) => b.length === 16));
    expect(checksumsFor(buf)?.familyId).toBe('ms42');
  });

  it('NEVER shadows a built-in: ms41 still wins on an MS41 image', () => {
    registerExternalFamily(fake('ms41', () => true));
    expect(checksumsFor(ms41Image(FULL))?.familyId).toBe('ms41');
    // …and it is the BUILT-IN one, which reports real blocks.
    expect(checksumsFor(ms41Image(FULL))!.verify(ms41Image(FULL)).blocks.length).toBeGreaterThan(0);
  });

  it('keeps both when two externals claim the same id, first registered winning', () => {
    registerExternalFamily(fake('dup', () => true));
    registerExternalFamily(fake('dup', () => true));
    expect(externalFamilies()).toHaveLength(2);
    expect(checksumsFor(new Uint8Array(4))?.familyId).toBe('dup');
  });

  it('hands out a list a caller cannot mutate', () => {
    registerExternalFamily(fake('ms42', () => true));
    const list = externalFamilies() as FamilyChecksums[];
    expect(() => list.push(fake('x', () => true))).toThrow();
  });
});
