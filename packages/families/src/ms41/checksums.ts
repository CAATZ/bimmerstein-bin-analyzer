import type { FamilyChecksums, ChecksumBlock, ChecksumReport } from '../types.js';
import { crc16 } from '../crc16.js';
import { trimEnd, u16le } from '../bytes.js';
import { calEntries, findCalTable, isCoherentCalTable } from './cal.js';

/**
 * MS41 checksum semantics, transcribed from the patch tooling's reference
 * implementation. Every address here is a FILE OFFSET in the image being
 * checked — no storage-address framing is involved.
 *
 * Confidence is NOT uniform across the three checksums:
 *   - calibration table : verified for MS41.0/.1/.2 AND MS41.3
 *   - boot sector       : verified across variants
 *   - program           : verified for MS41.0/.1/.2 ONLY; the MS41.3 layout is
 *                         unconfirmed, and the reference tooling always leaves
 *                         it untouched.
 * So boot and cal are authoritative blocks; program is always reported via
 * `skipped`, carrying its numbers in the reason. Promoting it needs a variant
 * discriminator and confirmation of the MS41.3 layout — deliberately out of
 * scope here.
 */
export const FULL_ROM_SIZE = 256 * 1024;
export const TUNE_SIZE = 24 * 1024;

const BOOT_REGION = { start: 0x4000, end: 0x5c14 } as const;
const BOOT_INIT = 0x4711;
const BOOT_STORE = 0x5c80;

const PROG_STORE = 0x6050;
const PROG_INIT_AT = 0x6066;

const SWITCH_ADDR = 0x605c;
const SWITCH_ENABLED = 0x30;
const SWITCH_DISABLED = 0xff;

const PROGRAM_SKIP_REASON =
  'program-checksum layout is confirmed only for MS41.0/.1/.2; not vouched for here';

const hex = (v: number, w = 4): string => `0x${v.toString(16).toUpperCase().padStart(w, '0')}`;

function bootBlock(d: Uint8Array): ChecksumBlock {
  const computed = crc16(d.subarray(BOOT_REGION.start, BOOT_REGION.end), BOOT_INIT);
  const stored = u16le(d, BOOT_STORE);
  return {
    id: 'boot',
    label: 'Boot sector',
    covers: { ...BOOT_REGION },
    storedAt: BOOT_STORE,
    stored,
    computed,
    ok: stored === computed,
  };
}

/**
 * The program checksum, computed for INFORMATION only. Three CRCs chained in
 * this exact order, each seeded with the previous result; each region has its
 * own trim anchor and they are not interchangeable.
 */
function programComputed(d: Uint8Array): number {
  let s = crc16(d.subarray(0x6100, trimEnd(d, 0x7fff)), (d[PROG_INIT_AT]! << 8) | d[PROG_INIT_AT + 1]!);
  s = crc16(d.subarray(0x0000, trimEnd(d, 0x3fff)), s);
  const buf = new Uint8Array(0x20000);
  const banks: readonly (readonly [number, number])[] = [
    [0x24000, 0x00000], [0x20000, 0x04000], [0x2c000, 0x08000], [0x28000, 0x0c000],
    [0x34000, 0x10000], [0x30000, 0x14000], [0x3c000, 0x18000], [0x38000, 0x1c000],
  ];
  for (const [src, dst] of banks) buf.set(d.subarray(src, src + 0x4000), dst);
  return crc16(buf.subarray(0x00000, trimEnd(buf, 0x1ffff)), s);
}

function switchNote(d: Uint8Array): string {
  const b = d[SWITCH_ADDR]!;
  if (b === SWITCH_ENABLED) return `Boot verification enabled (${hex(SWITCH_ADDR, 5)}=${hex(b, 2)}).`;
  if (b === SWITCH_DISABLED) {
    return `Boot verification DISABLED (${hex(SWITCH_ADDR, 5)}=${hex(b, 2)}) — the ECU will not reject a bad checksum.`;
  }
  return `Boot verification switch is an unrecognised value (${hex(SWITCH_ADDR, 5)}=${hex(b, 2)}).`;
}

function calBlocks(d: Uint8Array, start: number): ChecksumBlock[] {
  return calEntries(d, start).map((e, i) => {
    const stored = u16le(d, e.store);
    return {
      id: `cal-${i}`,
      label: `Calibration ${i}`,
      covers: { start: e.from, end: e.store },
      storedAt: e.store,
      stored,
      computed: e.calc,
      ok: stored === e.calc,
    };
  });
}

function inapplicable(): ChecksumReport {
  return {
    familyId: 'ms41',
    applies: false,
    blocks: [],
    valid: false,
    skipped: [],
    notes: ['Not a recognised MS41 image (need 262,144 or 24,576 bytes with a calibration checksum table).'],
  };
}

export const ms41Checksums: FamilyChecksums = {
  familyId: 'ms41',

  applies(bytes) {
    if (bytes.length !== FULL_ROM_SIZE && bytes.length !== TUNE_SIZE) return false;
    return isCoherentCalTable(bytes, findCalTable(bytes));
  },

  verify(bytes) {
    if (!this.applies(bytes)) return inapplicable();
    const start = findCalTable(bytes);
    const blocks: ChecksumBlock[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const notes: string[] = [];

    if (bytes.length === FULL_ROM_SIZE) {
      blocks.push(bootBlock(bytes));
      const pc = programComputed(bytes);
      const ps = u16le(bytes, PROG_STORE);
      skipped.push({
        id: 'program',
        reason: `${PROGRAM_SKIP_REASON} — stored ${hex(ps)}, computed ${hex(pc)}`,
      });
      notes.push(switchNote(bytes));
    } else {
      skipped.push({ id: 'boot', reason: 'lives outside a 24 KB partial' });
      skipped.push({ id: 'program', reason: 'lives outside a 24 KB partial' });
      notes.push('24 KB partial: the calibration table is the only checksum present, and the only one a partial write must fix.');
    }

    blocks.push(...calBlocks(bytes, start));
    return {
      familyId: 'ms41',
      applies: true,
      blocks,
      valid: blocks.length > 0 && blocks.every((b) => b.ok),
      skipped,
      notes,
    };
  },

  correct(bytes) {
    const out = new Uint8Array(bytes);
    const changed: { offset: number; from: number; to: number }[] = [];
    if (!this.applies(out)) return { bytes: out, report: inapplicable(), changed };

    const write16 = (at: number, v: number): void => {
      for (const [i, b] of [v & 0xff, (v >>> 8) & 0xff].entries()) {
        if (out[at + i] !== b) {
          changed.push({ offset: at + i, from: out[at + i]!, to: b });
          out[at + i] = b;
        }
      }
    };

    // Boot (full ROM only). The PROGRAM checksum is deliberately never written —
    // its layout is unconfirmed for MS41.3 and the reference tooling always
    // leaves it alone.
    if (out.length === FULL_ROM_SIZE) {
      const b = bootBlock(out);
      if (!b.ok) write16(BOOT_STORE, b.computed);
    }

    // Calibration table — present in both framings, recomputed from the FINAL
    // image so an earlier repair is included.
    const start = findCalTable(out);
    for (const e of calEntries(out, start)) {
      if (u16le(out, e.store) !== e.calc) write16(e.store, e.calc);
    }

    return { bytes: out, report: this.verify(out), changed };
  },
};
