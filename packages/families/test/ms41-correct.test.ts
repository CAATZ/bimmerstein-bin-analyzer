import { describe, expect, it } from 'vitest';
import { ms41Checksums } from '../src/ms41/checksums.js';
import { FULL, TUNE, ms41Image } from './fixture.js';

describe('ms41Checksums.correct', () => {
  it('never mutates the input buffer', () => {
    const d = ms41Image(FULL);
    d[0x5000] = d[0x5000]! ^ 0xff;
    const before = Uint8Array.from(d);
    ms41Checksums.correct(d);
    expect(d).toEqual(before);
  });

  it('is a no-op on an already-valid image', () => {
    const d = ms41Image(FULL);
    const r = ms41Checksums.correct(d);
    expect(r.changed).toEqual([]);
    expect(r.bytes).toEqual(d);
  });

  for (const [name, size, victim, storeAt] of [
    ['full ROM (boot region)', FULL, 0x5000, 0x5c80],
    ['full ROM (cal region)', FULL, 0x14010, 0x1404e],
    ['24 KB partial (cal region)', TUNE, 0x1010, 0x104e],
  ] as const) {
    it(`round-trips a corrupted ${name}: verify fails → correct → verify passes AND only the victim and its checksum store differ`, () => {
      const original = ms41Image(size);
      expect(ms41Checksums.verify(original).valid).toBe(true);

      const damaged = Uint8Array.from(original);
      damaged[victim] = damaged[victim]! ^ 0xff;
      expect(ms41Checksums.verify(damaged).valid).toBe(false);

      const fixed = ms41Checksums.correct(damaged);
      expect(fixed.report.valid).toBe(true);

      // Corrupting a byte INSIDE a covered region necessarily changes that
      // checksum, so correct() must rewrite its two stored bytes. The strong
      // clause is that NOTHING ELSE differs: an over-broad correction that
      // satisfied a checksum by touching other bytes would fail here, and so
      // would one that repaired the wrong checksum's store.
      const diffs: number[] = [];
      for (let i = 0; i < original.length; i++) if (original[i] !== fixed.bytes[i]) diffs.push(i);
      expect(diffs).toEqual([victim, storeAt, storeAt + 1]);
    });
  }

  it('reports every byte it changed', () => {
    const d = ms41Image(FULL);
    d[0x5000] = d[0x5000]! ^ 0xff;
    const r = ms41Checksums.correct(d);
    expect(r.changed.length).toBeGreaterThan(0);
    for (const c of r.changed) {
      expect(c.from).toBe(d[c.offset]);
      expect(c.to).toBe(r.bytes[c.offset]);
      expect(c.from).not.toBe(c.to);
    }
  });

  it('leaves an inapplicable image untouched', () => {
    const d = new Uint8Array(4096);
    const r = ms41Checksums.correct(d);
    expect(r.changed).toEqual([]);
    expect(r.report.applies).toBe(false);
  });

  it('never writes the program checksum', () => {
    const d = ms41Image(FULL);
    const originalProg = [d[0x6050], d[0x6051]];
    d[0x5000] = d[0x5000]! ^ 0xff;
    const r = ms41Checksums.correct(d);
    expect([r.bytes[0x6050], r.bytes[0x6051]]).toEqual(originalProg);
    expect(r.changed.some((c) => c.offset === 0x6050 || c.offset === 0x6051)).toBe(false);
  });
});
