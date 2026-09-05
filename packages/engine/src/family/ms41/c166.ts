import { cpuToFile, inCalWindow } from './frame.js';

/**
 * C166 opcode → instruction length in bytes (0 = unobserved; the sweep decodes
 * unobserved opcodes as 2 and resynchronizes naturally — C166 instructions are
 * 2 or 4 bytes and lengths are opcode-determined, which is what makes a linear
 * sweep sound). VENDORED constant: derived once from a verified MS41.3
 * linear-sweep disassembly by per-opcode majority vote (198/256 opcodes
 * observed, zero conflicts; spike 2026-07-09). The engine has NO runtime
 * dependency on that external source — this table plus its unit tests ARE the
 * contract. JMPS (0xFA) is four bytes even though it was absent from that
 * corpus; treating its address operand as an instruction loses alignment.
 * Structural ISA facts — not heuristics — hence not in config.ts.
 */
export const C166_OPCODE_LEN: readonly number[] = [
  2, 2, 4, 4, 4, 4, 4, 4, 2, 2, 4, 2, 0, 2, 2, 2, // 0x00
  2, 0, 4, 4, 4, 4, 4, 0, 2, 0, 4, 2, 2, 0, 2, 2, // 0x10
  2, 2, 4, 4, 4, 4, 4, 4, 2, 2, 4, 2, 0, 2, 2, 2, // 0x20
  2, 0, 4, 0, 4, 4, 4, 0, 0, 0, 4, 0, 2, 2, 2, 2, // 0x30
  2, 2, 4, 4, 0, 0, 4, 4, 2, 2, 4, 2, 2, 2, 2, 2, // 0x40
  2, 2, 4, 4, 4, 4, 4, 4, 2, 2, 4, 2, 2, 2, 2, 2, // 0x50
  2, 0, 4, 4, 4, 4, 4, 4, 2, 2, 4, 2, 0, 2, 2, 2, // 0x60
  2, 2, 4, 4, 4, 4, 4, 4, 2, 2, 4, 2, 2, 2, 2, 2, // 0x70
  2, 2, 0, 0, 4, 0, 0, 0, 2, 0, 4, 0, 0, 2, 2, 2, // 0x80
  2, 2, 4, 0, 4, 0, 0, 0, 2, 2, 4, 2, 2, 2, 2, 2, // 0x90
  2, 2, 4, 0, 4, 0, 0, 4, 2, 2, 4, 0, 2, 2, 2, 2, // 0xa0
  0, 2, 0, 0, 4, 0, 0, 0, 2, 2, 0, 0, 2, 2, 2, 2, // 0xb0
  2, 0, 4, 0, 4, 4, 4, 0, 2, 2, 4, 2, 2, 2, 2, 2, // 0xc0
  2, 0, 4, 0, 4, 0, 0, 0, 2, 0, 4, 2, 2, 2, 2, 2, // 0xd0
  2, 2, 0, 0, 4, 0, 4, 4, 2, 0, 4, 0, 2, 2, 2, 2, // 0xe0
  2, 2, 4, 4, 4, 0, 4, 4, 0, 0, 4, 2, 2, 2, 2, 2, // 0xf0
];

/** MOV Rwn,#data16 general form; second byte 0xFC selects r12 as destination. */
const OP_MOV_REG_IMM16 = 0xe6;
const REGBYTE_R12 = 0xfc;
/** CALLS seg,#offset16 — the cal readers are far entry points. */
const OP_CALLS = 0xda;
/**
 * Opcodes that end an r12-freshness window (control transfer: CALLA, CALLR,
 * PCALL, JMPS, RETS, RET, RETI). Conservative — a callee may clobber r12.
 */
const WINDOW_ENDERS = new Set([0xca, 0xbb, 0xe7, 0xfa, 0xdb, 0xcb, 0xfb]);

export interface ReaderCall {
  /** File offset of the CALLS instruction. */
  siteFile: number;
  /** Callee CPU address ((seg << 16) | offset16). */
  targetCpu: number;
  /** The fresh r12 immediate at the call — a cal storageaddress when the callee is a cal reader. */
  sa: number;
  /** Instructions between the MOV r12,#data16 and the CALLS. */
  dist: number;
}

/**
 * Linear sweep of the non-cal file, tracking MOV r12,#data16 (E6 FC lo hi)
 * freshness up to the next CALLS. Decode alignment resets at every 0x4000
 * boundary (bank halves are independently coherent in the raw file); the two
 * calibration ranges are skipped, preserving the executable half of the
 * mixed bank at file [0x12000,0x14000).
 *
 * r12-clobber (conservative lite set — abort freshness):
 *  - 4-byte reg,#imm16 ALU/mov forms: opcode low nibble 6, second byte 0xFC
 *    (E6 FC itself refreshes instead);
 *  - 2-byte reg,reg forms with destination r12: opcode < 0x60 or 0xF0, low
 *    nibble 0, second-byte high nibble 0xC;
 *  - short ALU forms writing r12 (including #data3 and indirect operands);
 *  - any WINDOW_ENDERS opcode (CALLS itself records, then resets).
 * Measured (spike 2026-07-09): recovers 61/62 (e36m3) and 67/68 (s52) truth
 * table starts at maxDist 6.
 */
export function scanReaderCalls(bytes: Uint8Array, maxDist: number): ReaderCall[] {
  const calls: ReaderCall[] = [];
  for (let chunk = 0; chunk < bytes.length; chunk += 0x4000) {
    const start = chunk === 0x10000 ? 0x12000 : chunk;
    if (inCalWindow(start)) continue;
    const end = Math.min(chunk + 0x4000, bytes.length);
    let o = start;
    let r12val = -1;
    let r12dist = Infinity;
    while (o + 1 < end) {
      const op = bytes[o]!;
      let L = C166_OPCODE_LEN[op]!;
      if (L === 0) L = 2;
      if (o + L > end) break;
      const b1 = bytes[o + 1]!;
      if (op === OP_MOV_REG_IMM16 && b1 === REGBYTE_R12) {
        r12val = bytes[o + 2]! | (bytes[o + 3]! << 8);
        r12dist = 0;
      } else if (op === OP_CALLS) {
        if (r12val >= 0 && r12dist <= maxDist) {
          const targetCpu = (b1 << 16) | bytes[o + 2]! | (bytes[o + 3]! << 8);
          calls.push({ siteFile: o, targetCpu, sa: r12val, dist: r12dist });
        }
        r12val = -1;
        r12dist = Infinity;
      } else if (WINDOW_ENDERS.has(op)) {
        r12val = -1;
        r12dist = Infinity;
      } else {
        const lowNib = op & 0x0f;
        if (L === 4 && lowNib === 6 && b1 === REGBYTE_R12) {
          r12val = -1;
          r12dist = Infinity;
        } else if (L === 2 && (op < 0x60 || op === 0xf0) && (b1 & 0xf0) === 0xc0 && lowNib === 0) {
          r12val = -1;
          r12dist = Infinity;
        } else if (L === 2 && op < 0x80 && op !== 0x48 && lowNib === 8 && (b1 & 0xf0) === 0xc0) {
          r12val = -1;
          r12dist = Infinity;
        } else if (r12val >= 0) r12dist++;
      }
      o += L;
    }
  }
  return calls;
}

/** First-fetch opcodes classifying a reader body: byte loads vs word loads. */
const FETCH_BYTE = new Set([0xa9, 0x99]); // MOVB Rbn,[Rwm] / [Rwm+]
const FETCH_WORD = new Set([0xa8, 0x98, 0xd4]); // MOV Rwn,[Rwm] / [Rwm+] / [Rwm+#d16]
const RETURN_OPS = new Set([0xdb, 0xcb, 0xfb]); // RETS / RET / RETI

/**
 * Classify a callee as byte- or word-reader by the first fetch opcode in its
 * body (scanning up to maxInstr decoded instructions, clamped to the callee's
 * 0x4000 bank half). 0 = no fetch found (not a table reader). Measured to
 * match truth width on every recalled table (61/61, 67/67).
 */
export function classifyReaderWidth(bytes: Uint8Array, entryCpu: number, maxInstr: number): 1 | 2 | 0 {
  if (entryCpu >= 0xc000 && entryCpu < 0x10000) return 0; // segment-0 RAM/SFR window has no flash body
  let o = cpuToFile(entryCpu);
  const bankEnd = (Math.floor(o / 0x4000) + 1) * 0x4000;
  for (let i = 0; i < maxInstr && o + 1 < Math.min(bankEnd, bytes.length); i++) {
    const op = bytes[o]!;
    if (FETCH_BYTE.has(op)) return 1;
    if (FETCH_WORD.has(op)) return 2;
    if (RETURN_OPS.has(op)) return 0;
    let L = C166_OPCODE_LEN[op]!;
    if (L === 0) L = 2;
    o += L;
  }
  return 0;
}
