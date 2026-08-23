import { describe, expect, it } from 'vitest';
import { ms41Checksums } from '../src/ms41/checksums.js';
import { CAL_MAGIC, calEntries, calWalk, findCalTable } from '../src/ms41/cal.js';
import { FULL, TUNE, ms41Image } from './fixture.js';

describe('ms41Checksums.applies', () => {
  it('rejects an unrecognised size', () => {
    expect(ms41Checksums.applies(new Uint8Array(1234))).toBe(false);
  });

  it('rejects a recognised size with no cal magic — no confident garbage', () => {
    expect(ms41Checksums.applies(new Uint8Array(FULL))).toBe(false);
  });

  it('accepts a full ROM and a 24 KB partial carrying a cal table', () => {
    expect(ms41Checksums.applies(ms41Image(FULL))).toBe(true);
    expect(ms41Checksums.applies(ms41Image(TUNE))).toBe(true);
  });

  it('rejects a magic sitting in erased flash — one entry is not a table', () => {
    // The magic's own first two bytes ARE entry 0's offset word, so every
    // occurrence yields one entry. A magic landing in a 0xFF padding run walks
    // exactly one and hits the terminator immediately — the single most likely
    // false positive in a real non-MS41 image, and the old gate accepted it.
    const d = new Uint8Array(TUNE).fill(0xff);
    d.set(CAL_MAGIC, 0x1000);
    expect(calWalk(d, findCalTable(d))).toMatchObject({ terminated: true });
    expect(calEntries(d, findCalTable(d))).toHaveLength(1);
    expect(ms41Checksums.applies(d)).toBe(false);
  });

  it('rejects a walk that never reaches the terminator', () => {
    // Offsets that keep advancing but never hit 0xFFFF: the walk dies on a
    // bounds guard or the entry cap, which a real table never does.
    const d = new Uint8Array(TUNE);
    for (let i = 0; i < d.length; i++) d[i] = (i * 7) % 251; // no 0xFF anywhere
    d.set(CAL_MAGIC, 0x1000);
    expect(calWalk(d, findCalTable(d)).terminated).toBe(false);
    expect(ms41Checksums.applies(d)).toBe(false);
  });
});

describe('ms41Checksums.verify — full ROM', () => {
  it('reports boot + cal as valid on a well-formed image', () => {
    const r = ms41Checksums.verify(ms41Image(FULL));
    expect(r.applies).toBe(true);
    expect(r.blocks.map((b) => b.id)).toEqual(['boot', 'program', 'cal-0', 'cal-1', 'cal-2', 'cal-3']);
    // Every checksum THIS TOOL WRITES is ok. `valid` is deliberately NOT
    // asserted: the synthetic fixture carries an arbitrary program checksum,
    // and a stale checksum we never write makes an image invalid by design.
    expect(r.blocks.filter((b) => b.correctable).every((b) => b.ok)).toBe(true);
  });

  it('reports the PROGRAM checksum but marks it as one we never write', () => {
    // This test's premise was deliberately reversed: the program checksum USED
    // to be hidden in `skipped` so it could not gate anything. It is now a
    // block, so a stale one does make an image invalid — what it must never do
    // is get written. `correctable: false` is that promise, and
    // ms41-correct.test.ts pins it.
    const r = ms41Checksums.verify(ms41Image(FULL));
    const program = r.blocks.find((b) => b.id === 'program');
    expect(program).toBeDefined();
    expect(program!.correctable).toBe(false);
    expect(r.skipped.some((s) => s.id === 'program')).toBe(false);
  });

  it('notes the boot-verification switch state', () => {
    const r = ms41Checksums.verify(ms41Image(FULL));
    expect(r.notes.join(' ')).toMatch(/enabled/i);
  });

  it('fails when a covered byte changes', () => {
    const d = ms41Image(FULL);
    d[0x5000] = d[0x5000]! ^ 0xff; // inside the boot region
    const r = ms41Checksums.verify(d);
    expect(r.valid).toBe(false);
    expect(r.blocks.find((b) => b.id === 'boot')!.ok).toBe(false);
  });
});

describe('ms41Checksums.verify — 24 KB partial', () => {
  it('evaluates cal only and skips boot/program as out of frame', () => {
    const r = ms41Checksums.verify(ms41Image(TUNE));
    expect(r.valid).toBe(true);
    expect(r.blocks.map((b) => b.id)).toEqual(['cal-0', 'cal-1', 'cal-2', 'cal-3']);
    expect(r.skipped.map((s) => s.id).sort()).toEqual(['boot', 'program']);
    for (const s of r.skipped) expect(s.reason).toMatch(/partial/i);
  });
});

describe('ms41Checksums.verify — inapplicable', () => {
  it('returns applies:false with no blocks and valid:false', () => {
    const r = ms41Checksums.verify(new Uint8Array(4096));
    expect(r).toMatchObject({ applies: false, valid: false, blocks: [] });
  });
});

describe('a non-correctable block carries the ranges it covers', () => {
  it('the program block names its three regions on a full ROM', () => {
    const r = ms41Checksums.verify(ms41Image(FULL));
    const program = r.blocks.find((b) => b.id === 'program')!;
    expect(program.covers).toEqual([
      { start: 0x0000, end: 0x4000 },
      { start: 0x6100, end: 0x8000 },
      { start: 0x20000, end: 0x40000 },
    ]);
  });

  it('does NOT overlap the MS41 full-read calibration window', () => {
    // fo(SA) = (0x10000 + SA) ^ 0x4000 lands cal in [0x10000, 0x18000), which is
    // disjoint from all three program regions. This is what lets a save tell a
    // tuner their calibration edit did not disturb the checksum it will not fix.
    const program = ms41Checksums.verify(ms41Image(FULL)).blocks.find((b) => b.id === 'program')!;
    for (const c of program.covers) {
      expect(c.start >= 0x18000 || c.end <= 0x10000).toBe(true);
    }
  });

  it('a skipped entry carries nothing but an id and a reason', () => {
    // Absent, not merely unwritten: there is nothing to cover and nothing to
    // measure. Pinned as a SHAPE so a future module cannot quietly reintroduce
    // the optional fields that used to smuggle the program checksum through.
    const r = ms41Checksums.verify(ms41Image(TUNE));
    expect(r.skipped.length).toBeGreaterThan(0);
    for (const s of r.skipped) expect(Object.keys(s).sort()).toEqual(['id', 'reason']);
  });
});

describe('a non-correctable block reports its numbers as DATA', () => {
  it('the program block carries stored + computed like any other block', () => {
    // The acceptance harness pins the program CRC against real firmware, so it
    // needs these structured — and the program path is the one checksum
    // computation with no other real-bin coverage. It used to reach them through
    // a reason string; as a block it simply has the fields.
    const d = ms41Image(FULL);
    const program = ms41Checksums.verify(d).blocks.find((b) => b.id === 'program')!;
    expect(program.stored).toBe(d[0x6050]! | (d[0x6051]! << 8));
    expect(program.storedAt).toBe(0x6050);
    expect(typeof program.computed).toBe('number');
    expect(program.ok).toBe(program.stored === program.computed);
  });
});

describe('a block reports its coverage as a list', () => {
  it('marks boot and cal — the checksums it writes — as correctable', () => {
    const r = ms41Checksums.verify(ms41Image(FULL));
    const written = r.blocks.filter((b) => b.id !== 'program');
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((b) => b.correctable)).toBe(true);
  });

  it('every block reports its coverage as a list of ranges', () => {
    const r = ms41Checksums.verify(ms41Image(FULL));
    expect(r.blocks.length).toBeGreaterThan(0);
    for (const b of r.blocks) {
      expect(Array.isArray(b.covers)).toBe(true);
      expect(b.covers.length).toBeGreaterThanOrEqual(1);
      for (const c of b.covers) expect(c.end).toBeGreaterThan(c.start);
    }
  });
});

describe('the program checksum is a block we never write', () => {
  it('reports the program checksum as a block that is NOT correctable', () => {
    const r = ms41Checksums.verify(ms41Image(FULL));
    const program = r.blocks.find((b) => b.id === 'program');
    expect(program).toBeDefined();
    expect(program!.correctable).toBe(false);
    expect(program!.covers).toEqual([
      { start: 0x0000, end: 0x4000 },
      { start: 0x6100, end: 0x8000 },
      { start: 0x20000, end: 0x40000 },
    ]);
    expect(r.skipped.some((s) => s.id === 'program')).toBe(false);
  });

  it('says in a note that the program checksum is never written', () => {
    const r = ms41Checksums.verify(ms41Image(FULL));
    expect(r.notes.join(' ')).toMatch(/never written/i);
  });

  it('keeps the program checksum SKIPPED on a 24 KB partial, where it is absent', () => {
    const r = ms41Checksums.verify(ms41Image(TUNE));
    expect(r.blocks.some((b) => b.id === 'program')).toBe(false);
    expect(r.skipped.map((s) => s.id)).toContain('program');
  });
});
