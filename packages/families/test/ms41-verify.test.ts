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
    expect(r.valid).toBe(true);
    expect(r.blocks.map((b) => b.id)).toEqual(['boot', 'cal-0', 'cal-1', 'cal-2', 'cal-3']);
    expect(r.blocks.every((b) => b.ok)).toBe(true);
  });

  it('never treats the PROGRAM checksum as authoritative', () => {
    // The reference verifies program only for MS41.0/.1/.2 and its own tooling
    // always passes correct_program=False. It is reported, never gating.
    const r = ms41Checksums.verify(ms41Image(FULL));
    expect(r.blocks.some((b) => b.id === 'program')).toBe(false);
    expect(r.skipped.map((s) => s.id)).toContain('program');
    expect(r.skipped.find((s) => s.id === 'program')!.reason).toMatch(/MS41\.0/);
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
