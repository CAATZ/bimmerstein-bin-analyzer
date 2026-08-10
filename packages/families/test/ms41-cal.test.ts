import { describe, expect, it } from 'vitest';
import { crc16 } from '../src/crc16.js';
import { CAL_MAGIC, calEntries, calWalk, findCalTable } from '../src/ms41/cal.js';

/**
 * Build a minimal image carrying a valid cal table, laid out like real
 * firmware: the magic marks `start`, and its first two bytes ARE entry 0's
 * offset word (`ss = 0x004E`), so entry 0 covers [start, start + 0x4E) and the
 * next entry begins at start + 0x50. The init is a BE u16 at start + 0x0E,
 * inside entry 0's covered range — exactly as on a real image. The walk stops
 * at 0xFFFF.
 */
function imageWithCalTable(): { d: Uint8Array; start: number } {
  const d = new Uint8Array(0x400).fill(0x00);
  const start = 0x100;
  d.set(CAL_MAGIC, start);
  d[start + 0x0e] = 0x12; // init BE hi
  d[start + 0x0f] = 0x34; // init BE lo
  d[start + 0x50] = 0xff; // terminate entry 1
  d[start + 0x51] = 0xff;
  return { d, start };
}

describe('MS41 cal table', () => {
  it('locates the table by magic', () => {
    const { d, start } = imageWithCalTable();
    expect(findCalTable(d)).toBe(start);
  });

  it('returns -1 when the magic is absent', () => {
    expect(findCalTable(new Uint8Array(0x400))).toBe(-1);
  });

  it('walks entries, computing the CRC over [pos, store) with the BE init', () => {
    const { d, start } = imageWithCalTable();
    const entries = calEntries(d, start);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.store).toBe(start + 0x4e);
    expect(e.from).toBe(start);
    expect(e.calc).toBe(crc16(d.subarray(start, start + 0x4e), 0x1234));
  });

  it('yields nothing when the FIRST offset word is already the terminator', () => {
    const { d, start } = imageWithCalTable();
    // Entry 0's offset word is read at `pos === start`, so a 0xFFFF there ends
    // the walk before a single entry exists — the name says that rather than
    // implying a mid-walk stop.
    // Overwrites d[start]/d[start+1], which also destroys the magic's first
    // two bytes — intentional: this test calls calEntries(d, start) directly
    // with an explicit `start` rather than locating it via findCalTable, so
    // an intact magic is not needed here.
    d[start] = 0xff;
    d[start + 1] = 0xff;
    expect(calEntries(d, start)).toEqual([]);
    expect(calWalk(d, start).terminated).toBe(true);
  });

  it('reports WHY the walk ended, so a coincidence can be told from a real table', () => {
    // The magic's own first two bytes are entry 0's offset word, so ANY
    // occurrence of the magic yields at least one entry. Termination is what
    // separates a real table from a chance match.
    const { d, start } = imageWithCalTable();
    expect(calWalk(d, start).terminated).toBe(true);

    // Walk off the end instead of reaching the terminator.
    const runaway = Uint8Array.from(d);
    runaway[start + 0x50] = 0x00;
    runaway[start + 0x51] = 0xf0; // store far past the buffer ⇒ bounds guard, not terminator
    expect(calWalk(runaway, start).terminated).toBe(false);
  });

  it('stops when an entry would move BACKWARDS', () => {
    const { d, start } = imageWithCalTable();
    // Entry 0 ends at start+0x4E, so the walk resumes at start+0x50. Point the
    // next entry behind that and it must stop rather than loop or re-cover
    // ground it has already checksummed.
    d[start + 0x50] = 0x10;
    d[start + 0x51] = 0x00; // store = start + 0x10, which is < pos
    const w = calWalk(d, start);
    expect(w.entries).toHaveLength(1);
    expect(w.terminated).toBe(false);
  });

  it('stops at the 20-entry cap when offsets keep advancing without a terminator', () => {
    // Offsets that step forward forever: the cap is the only thing that ends
    // this walk, so it stays bounded and reports itself unterminated.
    const d = new Uint8Array(0x400);
    for (let k = 0; k < 30; k++) {
      const pos = 4 * k; // entry k covers [pos, pos + 2), next pos = pos + 4
      d[pos] = (pos + 2) & 0xff;
      d[pos + 1] = ((pos + 2) >>> 8) & 0xff;
    }
    const w = calWalk(d, 0);
    expect(w.entries).toHaveLength(20);
    expect(w.terminated).toBe(false);
  });

  it('stops when an entry would point outside the buffer', () => {
    const { d, start } = imageWithCalTable();
    // Same intentional magic-destroying overwrite as above — calEntries is
    // called directly with an explicit `start`.
    d[start] = 0x00;
    d[start + 1] = 0xf0; // store = start + 0xF000, past the 0x400 image
    expect(calEntries(d, start)).toEqual([]);
  });
});
