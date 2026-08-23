import type { FamilyChecksums, ChecksumBlock, ChecksumReport } from '../types.js';
import { crc16 } from '../crc16.js';
import { trimEnd, u16le } from '../bytes.js';
import { calEntries, calWalk, findCalTable, isCoherentCalTable, isCoherentWalk, FULL_ROM_SIZE, TUNE_SIZE, type CalEntry } from './cal.js';
import { ms41Identify } from './identity.js';

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
const BOOT_REGION = { start: 0x4000, end: 0x5c14 } as const;
const BOOT_INIT = 0x4711;
const BOOT_STORE = 0x5c80;

const PROG_STORE = 0x6050;
const PROG_INIT_AT = 0x6066;

/**
 * The FILE ranges `programComputed` walks, at their nominal (untrimmed) extents.
 * trimEnd() may shorten the tail of each; reporting the full extent is the
 * conservative direction for "did an edit land inside this?".
 */
const PROGRAM_COVERS: { start: number; end: number }[] = [
  { start: 0x0000, end: 0x4000 },
  { start: 0x6100, end: 0x8000 },
  { start: 0x20000, end: 0x40000 },
];

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


function calBlocks(d: Uint8Array, entries: readonly CalEntry[]): ChecksumBlock[] {
  return entries.map((e, i) => {
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

const recognisedSize = (n: number): boolean => n === FULL_ROM_SIZE || n === TUNE_SIZE;

function appliesTo(bytes: Uint8Array): boolean {
  return recognisedSize(bytes.length) && isCoherentCalTable(bytes, findCalTable(bytes));
}

function verifyImage(bytes: Uint8Array): ChecksumReport {
  if (!recognisedSize(bytes.length)) return inapplicable();
  // ONE walk serves both the activation gate and the calibration blocks.
  const walk = calWalk(bytes, findCalTable(bytes));
  if (!isCoherentWalk(walk)) return inapplicable();

  const blocks: ChecksumBlock[] = [];
  const skipped: ChecksumReport['skipped'] = [];
  const notes: string[] = [];

  if (bytes.length === FULL_ROM_SIZE) {
    blocks.push(bootBlock(bytes));
    const pc = programComputed(bytes);
    const ps = u16le(bytes, PROG_STORE);
    skipped.push({
      id: 'program',
      reason: `${PROGRAM_SKIP_REASON} — stored ${hex(ps)}, computed ${hex(pc)}`,
      // Copied, never handed out by reference: verify() must not expose module
      // state a caller could mutate.
      covers: PROGRAM_COVERS.map((c) => ({ ...c })),
      // The same `ps`/`pc` the reason renders, as data. Not vouched for, but
      // MEASURED — and the acceptance harness pins them against real firmware,
      // which is the only regression coverage this computation has.
      stored: ps,
      computed: pc,
    });
    notes.push(switchNote(bytes));
  } else {
    skipped.push({ id: 'boot', reason: 'lives outside a 24 KB partial' });
    skipped.push({ id: 'program', reason: 'lives outside a 24 KB partial' });
    notes.push('24 KB partial: the calibration table is the only checksum present, and the only one a partial write must fix.');
  }

  blocks.push(...calBlocks(bytes, walk.entries));
  return {
    familyId: 'ms41',
    applies: true,
    blocks,
    valid: blocks.length > 0 && blocks.every((b) => b.ok),
    skipped,
    notes,
  };
}

function correctImage(bytes: Uint8Array): {
  bytes: Uint8Array;
  report: ChecksumReport;
  changed: { offset: number; from: number; to: number }[];
} {
  const out = new Uint8Array(bytes);
  const changed: { offset: number; from: number; to: number }[] = [];
  if (!appliesTo(out)) return { bytes: out, report: inapplicable(), changed };

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
  for (const e of calEntries(out, findCalTable(out))) {
    if (u16le(out, e.store) !== e.calc) write16(e.store, e.calc);
  }

  return { bytes: out, report: verifyImage(out), changed };
}

/**
 * Plain function references, not object methods: nothing here depends on
 * `this`, so destructuring the module or passing a method as a callback stays
 * safe.
 */
export const ms41Checksums: FamilyChecksums = {
  familyId: 'ms41',
  applies: appliesTo,
  identify: ms41Identify,
  verify: verifyImage,
  correct: correctImage,
};
