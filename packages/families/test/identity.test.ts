import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { identifyBin } from '../src/index.js';
import { FULL, ms41Image } from './fixture.js';

const fixture = (...parts: string[]): string =>
  join(import.meta.dirname, '..', '..', '..', 'fixtures', 'ms41', ...parts);

const FULL_READ = fixture('E36 M3 Stock Full Read.bin');
const S52_READ = fixture('MS41.3 S52 Stock Full Read.bin');
const PARTIAL = fixture('partial', 'E36 M3 Stock partial.bin');

const bytesOf = (p: string): Uint8Array => new Uint8Array(readFileSync(p));

describe('identifyBin', () => {
  it('returns undefined for a buffer no family recognises', () => {
    expect(identifyBin(new Uint8Array(1024))).toBeUndefined();
  });

  it('returns undefined for a right-sized buffer with no id bytes', () => {
    expect(identifyBin(new Uint8Array(262144))).toBeUndefined();
  });

  it('will not guess on an image the family DOES claim but that carries no romid', () => {
    // ms41Image is a structurally valid MS41 image by construction, so the
    // family claims it — and it still yields no id, because there is none to
    // read. "I do not know" must never degrade into a guess.
    expect(identifyBin(ms41Image(FULL))).toBeUndefined();
  });

  it('will not read an id out of a buffer the family does not claim', () => {
    // Digit bytes at the right offset are not enough: without a coherent cal
    // table this is not an MS41 image, and a pack must not be gated on it.
    const d = new Uint8Array(262144);
    for (let i = 0; i < 12; i++) d[0x1400e + i] = 0x39;
    expect(identifyBin(d)).toBeUndefined();
  });

  it('does not fall back to the partial offset when reading a full read', () => {
    // A full read whose romid slot is empty must stay unidentified rather than
    // scavenge whatever digits happen to sit at the 24 KB offset.
    const d = ms41Image(FULL);
    for (let i = 0; i < 12; i++) d[0x0e + i] = 0x39;
    expect(identifyBin(d)).toBeUndefined();
  });
});

describe.skipIf(!existsSync(FULL_READ))('identifyBin on real firmware', () => {
  it('reads the CAL-ID from a 256 KB full read', () => {
    expect(identifyBin(bytesOf(FULL_READ))).toEqual({ familyId: 'ms41', calId: '12' });
  });

  it('reads the same CAL-ID from the SS1v2 image, which is built on the ID12 base', () => {
    // Measured: both full reads carry "120111100900". This shared id is the
    // reason a pack authored on one transfers to the other at all.
    if (!existsSync(S52_READ)) return;
    expect(identifyBin(bytesOf(S52_READ))).toEqual({ familyId: 'ms41', calId: '12' });
  });

  it('reads the CAL-ID from a 24 KB cal partial, at its own offset', () => {
    if (!existsSync(PARTIAL)) return;
    expect(identifyBin(bytesOf(PARTIAL))).toEqual({ familyId: 'ms41', calId: '12' });
  });
});
