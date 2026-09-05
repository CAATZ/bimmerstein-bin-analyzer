import type { ScanConfig } from '../../config.js';
import type { FamilyDetection } from '../types.js';
import type { ValueFormat } from '@binanalyzer/core';
import { C166_OPCODE_LEN } from './c166.js';
import { MS41_CAL_SA_MAX, MS41_CAL_SA_MIN, inCalWindow, saSpanContiguous, saToFo } from './frame.js';

/**
 * S* code-referenced-parameter census. The V1d CALLS distance comes from
 * config.family.ms41.paramCallsMax (2; the ladder's pinned output ran at 3 —
 * S3-measured truth-flat, sheds 3 junk SAs/bin).
 *
 * Every SA the code direct-mem READS and tests/consumes (S* = V1a∪V1b∪V1c∪V1d)
 * emits a 1×1 potential map: kind 'param', tier 9, width from the byte-DATA
 * opcode class, address fo-framed. rankAndEmit places these LAST — below
 * every other tier — so any existing detection's span suppresses them.
 */

/** Params rank below every grid (0–3) and curve (4–8) tier. */
export const PARAM_TIER = 9;

/**
 * V1c flag-idiom reach: a plain load followed by a branch within 2
 * instructions. Part of the rung DEFINITION (ladder-exact), never swept —
 * unlike paramTestWindow/paramCallsMax, which were measured across ranges
 * and are therefore config knobs. Structural, so it stays here.
 */
const V1C_JMPR_MAX = 2;

// ---- instruction model (structural ISA facts — vendored, not config) ----
// Direct-mem READ ops, reg,mem F-form (b1 = 0xF0 | reg), length 4:
// ADD/ADDB/SUB/SUBB/CMP/CMPB/XOR/XORB/AND/ANDB/OR/ORB/MOV/MOVB plus
// MOVBZ 0xC2 / MOVBS 0xD2 (the DTC per-byte read idiom — audit A3).
const READ_MEM = new Set([0x02, 0x03, 0x22, 0x23, 0x42, 0x43, 0x52, 0x53, 0x62, 0x63, 0x72, 0x73, 0xf2, 0xf3, 0xc2, 0xd2]);
const SELF_TEST_MEM = new Set([0x42, 0x43, 0x52, 0x53, 0x62, 0x63, 0x72, 0x73]); // CMP/XOR/AND/OR reg,mem
const PLAIN_LOAD = new Set([0xf2, 0xf3, 0xc2, 0xd2]); // MOV/MOVB/MOVBZ/MOVBS reg,mem
/** Loaded DATUM is one byte (incl. zero/sign-extended loads) → emission width u8. */
const BYTE_DATA = new Set([0x03, 0x23, 0x43, 0x53, 0x63, 0x73, 0xf3, 0xc2, 0xd2]);
const TEST_IMM_W = new Set([0x46, 0x56, 0x66, 0x76]); // CMP/XOR/AND/OR Rwn,#imm16
const TEST_IMM_B = new Set([0x47, 0x57, 0x67, 0x77]); // CMPB/XORB/ANDB/ORB Rbn,#imm8
const TEST_RR_W = new Set([0x40, 0x50, 0x60, 0x70]);
const TEST_RR_B = new Set([0x41, 0x51, 0x61, 0x71]);
// 2-byte short forms, b1 = (reg << 4) | data. Low nibble 0–7 = #data3
// immediate; 8–15 = [Rwi]/[Rwi+] indirect — still a reg-test, no immediate
// (the ladder's S1-corrected #data3 guard).
const TEST_D4_W = new Set([0x48, 0x58, 0x68, 0x78]);
const TEST_D4_B = new Set([0x49, 0x59, 0x69, 0x79]);
/** Window enders (control transfer) + CALLS — identical to the ladder. */
const ENDERS = new Set([0xca, 0xbb, 0xe7, 0xfa, 0xdb, 0xcb, 0xfb, 0xda]);
const OP_CALLS = 0xda;

// ---- states-subclass aliveness (register-still-holds-load discipline) ----
// KILL = the matched register no longer holds (a mask-preserving function of)
// the raw cal load. AND/ANDB with an IMMEDIATE preserve aliveness: the
// dispatcher masks (#7) then equality-tests one-hot values — the measured
// recovery class (spike). Everything else that WRITES the register kills.
// Over-killing is safe (fewer states); under-killing is the measured 0x3a0
// phantom. Compare-only ops (0x42/0x43 CMP/CMPB mem, 0x46/0x47 CMP/CMPB imm,
// 0x48/0x49 short) appear in NO kill set — they read, never write. 0xE7 (a
// WINDOW_ENDER per the vendored ladder set) never reaches the check — the
// window breaks first.
// Writes are derived STRUCTURALLY from the C166 ALU encoding rather than
// hand-listed (a hand list silently missed whole families — e.g. ADD Rbn,#3
// between the load and the compare). Family = op >> 4: 0x0 ADD, 0x1 ADDC,
// 0x2 SUB, 0x3 SUBC, 0x4 CMP, 0x5 XOR, 0x6 AND, 0x7 OR. Form = op & 0xF:
// 0 Rwn,Rwm | 1 Rbn,Rbm | 2 Rwn,mem | 3 Rbn,mem | 4,5 mem,Rn (STORE — writes
// memory, not the register) | 6 Rwn,#imm16 | 7 Rbn,#imm8 | 8,9 Rn,#data3/[Rwi].
// Odd forms are byte-space. Dest nibble: HIGH for reg,reg and short forms,
// LOW for the F-form (b1 = 0xF0|reg) mem and #imm forms.
// EXEMPT: family 0x4 (CMP — compare-only, never writes), the AND
// TRUE-IMMEDIATE forms 0x66/0x67 (Rwn,#imm16 / Rbn,#imm8), and the AND
// #data3 SHORT form 0x68/0x69 ONLY when b1's low nibble ≤ 7 (the mask
// idiom that preserves the load — the measured one-hot recovery class).
// The SAME short-form opcodes (0x68/0x69) with b1's low nibble ≥ 8 encode
// [Rwi]/[Rwi+] INDIRECT addressing (per the TEST_D4_B/TEST_D4_W convention
// below) — a runtime memory combine, not a compile-time mask — and still
// kill, same as AND reg,reg and AND reg,mem.
// CAVEAT: when a mask preserves aliveness, the equality immediates collected
// afterward compare against the MASKED register, not the raw loaded byte —
// synthesized states are therefore "tested-value" states (valid write
// targets, matching the dispatcher's own comparisons), not a guaranteed
// exhaustive enumeration of the raw byte's bit patterns. The stock state
// (the literal byte observed in the image) is always exact.
const ALU_WRITE_FAMILIES = new Set([0x0, 0x1, 0x2, 0x3, 0x5, 0x6, 0x7]);

/**
 * The register an instruction WRITES as {byteForm, dest}, or undefined when
 * it writes no register. Classified by form so C166 byte/word register
 * ALIASING can be honored downstream: byte reg rbN lives inside word reg
 * r(N>>1), so a word write to r(N>>1) clobbers rbN, and a byte write to
 * rb(2W)/rb(2W+1) clobbers word reg rW.
 */
function writtenReg(op: number, b1: number): { byteForm: boolean; dest: number } | undefined {
  const lo = b1 & 0x0f;
  const hi = b1 >> 4;
  const fForm = (b1 & 0xf0) === 0xf0;
  const fam = op >> 4;
  const form = op & 0x0f;
  if (ALU_WRITE_FAMILIES.has(fam) && form <= 9 && form !== 4 && form !== 5) {
    if (fam === 0x6 && (form === 6 || form === 7)) return undefined; // AND #imm16/#imm8 — true immediate, mask preserves
    // AND #data3 short form (0x68/0x69): low nibble ≤7 is a true #data3
    // immediate (mask preserves); low nibble ≥8 is [Rwi]/[Rwi+] INDIRECT
    // addressing — falls through to the normal write-detection path (kill).
    if (fam === 0x6 && (form === 8 || form === 9) && (b1 & 0x0f) <= 7) return undefined;
    const byteForm = (form & 1) === 1;
    // Forms 2,3,6,7 are F-form (dest in the LOW nibble); 0,1,8,9 carry it high.
    if (form === 2 || form === 3 || form === 6 || form === 7) {
      return fForm ? { byteForm, dest: lo } : undefined;
    }
    return { byteForm, dest: hi };
  }
  // MOV family (not ALU-encoded).
  if (op === 0xf0) return { byteForm: false, dest: hi }; // MOV Rwn,Rwm
  if (op === 0xf1) return { byteForm: true, dest: hi }; // MOVB Rbn,Rbm
  if (fForm && (op === 0xf2 || op === 0xc2 || op === 0xd2)) return { byteForm: false, dest: lo }; // MOV/MOVBZ/MOVBS → word dest
  if (fForm && op === 0xf3) return { byteForm: true, dest: lo }; // MOVB Rbn,mem
  if (fForm && op === 0xe6) return { byteForm: false, dest: lo }; // MOV Rwn,#data16
  if (op === 0xe0) return { byteForm: false, dest: hi }; // MOV Rwn,#data4
  if (op === 0xe1) return { byteForm: true, dest: hi }; // MOVB Rbn,#data4
  return undefined;
}

/** True when a write to (byteForm, dest) clobbers the site's register. */
function clobbers(w: { byteForm: boolean; dest: number }, siteByteSpace: boolean, siteReg: number): boolean {
  if (w.byteForm === siteByteSpace) return w.dest === siteReg;
  // Cross-space: byte reg N ⊂ word reg N>>1.
  return siteByteSpace ? w.dest === siteReg >> 1 : w.dest >> 1 === siteReg;
}

const u8Fmt: ValueFormat = { width: 1, signed: false, endianness: 'big' };
const u16Fmt: ValueFormat = { width: 2, signed: false, endianness: 'little' };

export interface ParamSite {
  op: number;
  fileOff: number;
  /** Direct-mem operand (== SA under the DPP0=4/DPP1=5 frame). */
  sa: number;
  reg: number;
  /** Ladder semantics: (op & 1) === 1 — MOVBZ/MOVBS are WORD-space here
   *  (measured-best test matching), even though their DATUM is a byte. */
  byteOp: boolean;
  selfTest: boolean;
  /** Instruction distance to the first reg-matching test (-1 none). */
  regTestDist: number;
  jmprDist: number;
  callsDist: number;
  /** Equality-compare immediates (CMP/CMPB, long + #data3 short) observed in
   *  the window. Task 4 narrows collection to register-still-holds-load. */
  eqImms: number[];
}

/** Decode forward from a load site collecting test evidence (ladder-exact). */
function analyzeWindow(
  bytes: Uint8Array,
  end: number,
  o0: number,
  L0: number,
  reg: number,
  byteOp: boolean,
  kWindow: number
): Pick<ParamSite, 'regTestDist' | 'jmprDist' | 'callsDist' | 'eqImms'> {
  let o = o0 + L0;
  let regTestDist = -1;
  let jmprDist = -1;
  let callsDist = -1;
  const eqImms: number[] = [];
  let alive = true;
  for (let i = 1; i <= kWindow && o + 1 < end; i++) {
    const op = bytes[o]!;
    let L = C166_OPCODE_LEN[op]!;
    if (L === 0) L = 2;
    if (o + L > end) break;
    const b1 = bytes[o + 1]!;
    if ((op & 0x0f) === 0x0d && L === 2) {
      if (jmprDist < 0) jmprDist = i;
    } else if (byteOp && TEST_D4_B.has(op) && (b1 >> 4) === reg) {
      if (regTestDist < 0) regTestDist = i;
      if (alive && op === 0x49 && (b1 & 0x0f) <= 7) eqImms.push(b1 & 0x0f); // CMPB #data3
    } else if (!byteOp && TEST_D4_W.has(op) && (b1 >> 4) === reg) {
      if (regTestDist < 0) regTestDist = i;
      if (alive && op === 0x48 && (b1 & 0x0f) <= 7) eqImms.push(b1 & 0x0f); // CMP #data3
    } else if (byteOp && TEST_IMM_B.has(op) && (b1 & 0xf0) === 0xf0 && (b1 & 0x0f) === reg) {
      if (regTestDist < 0) regTestDist = i;
      if (alive && op === 0x47) eqImms.push(bytes[o + 2]!); // CMPB #imm8
    } else if (!byteOp && TEST_IMM_W.has(op) && (b1 & 0xf0) === 0xf0 && (b1 & 0x0f) === reg) {
      if (regTestDist < 0) regTestDist = i;
      if (alive && op === 0x46) eqImms.push(bytes[o + 2]! | (bytes[o + 3]! << 8)); // CMP #imm16
    } else if (byteOp && TEST_RR_B.has(op) && ((b1 >> 4) === reg || (b1 & 0x0f) === reg)) {
      if (regTestDist < 0) regTestDist = i;
    } else if (!byteOp && TEST_RR_W.has(op) && ((b1 >> 4) === reg || (b1 & 0x0f) === reg)) {
      if (regTestDist < 0) regTestDist = i;
    }
    if (op === OP_CALLS && callsDist < 0) callsDist = i;
    if (ENDERS.has(op)) break;
    const w = writtenReg(op, b1);
    if (w !== undefined && clobbers(w, byteOp, reg)) alive = false;
    o += L;
  }
  return { regTestDist, jmprDist, callsDist, eqImms };
}

/** Chunked linear sweep (0x4000, cal-window chunks skipped) — ladder-exact. */
export function scanParamSites(bytes: Uint8Array, kWindow: number): ParamSite[] {
  const sites: ParamSite[] = [];
  for (let chunk = 0; chunk < bytes.length; chunk += 0x4000) {
    if (inCalWindow(chunk)) continue;
    const end = Math.min(chunk + 0x4000, bytes.length);
    let o = chunk;
    while (o + 1 < end) {
      const op = bytes[o]!;
      let L = C166_OPCODE_LEN[op]!;
      if (L === 0) L = 2;
      if (o + L > end) break;
      const b1 = bytes[o + 1]!;
      if (L === 4 && READ_MEM.has(op) && (b1 & 0xf0) === 0xf0) {
        const operand = bytes[o + 2]! | (bytes[o + 3]! << 8);
        // The ladder collected to 0x7fff for a frame-junk statistic and
        // filtered ≤ MS41_CAL_SA_MAX in every rung — filtering at collection
        // is rung-identical and cheaper.
        if (operand >= MS41_CAL_SA_MIN && operand <= MS41_CAL_SA_MAX) {
          const byteOp = (op & 1) === 1;
          const win = analyzeWindow(bytes, end, o, L, b1 & 0x0f, byteOp, kWindow);
          sites.push({
            op,
            fileOff: o,
            sa: operand,
            reg: b1 & 0x0f,
            byteOp,
            selfTest: SELF_TEST_MEM.has(op),
            ...win,
          });
        }
      }
      o += L;
    }
  }
  return sites;
}

/**
 * S* = V1a ∪ V1b ∪ V1c ∪ V1d → one 1×1 emission per SA. Width u8 if ANY
 * byte-DATA site reads the SA (smallest claim), else u16-LE.
 */
export function detectMs41Params(bytes: Uint8Array, config: ScanConfig): FamilyDetection[] {
  const { paramTestWindow, paramCallsMax, paramConfidence } = config.family.ms41;
  const sites = scanParamSites(bytes, paramTestWindow);
  const bySA = new Map<number, ParamSite[]>();
  const sStar = new Set<number>();
  for (const s of sites) {
    const arr = bySA.get(s.sa) ?? [];
    arr.push(s);
    bySA.set(s.sa, arr);
    const v1a = s.selfTest;
    const v1b = PLAIN_LOAD.has(s.op) && s.regTestDist >= 0;
    const v1c = PLAIN_LOAD.has(s.op) && s.regTestDist < 0 && s.jmprDist >= 0 && s.jmprDist <= V1C_JMPR_MAX;
    const v1d = PLAIN_LOAD.has(s.op) && s.regTestDist < 0 && s.callsDist >= 0 && s.callsDist <= paramCallsMax;
    if (v1a || v1b || v1c || v1d) sStar.add(s.sa);
  }
  const out: FamilyDetection[] = [];
  for (const sa of [...sStar].sort((a, b) => a - b)) {
    const ss = bySA.get(sa)!;
    const w: 1 | 2 = ss.some((s) => BYTE_DATA.has(s.op)) ? 1 : 2;
    if (!saSpanContiguous(sa, w)) continue; // the SA 0x3fff→0x4000 seam
    const fo = saToFo(sa);
    if (!inCalWindow(fo) || fo + w > bytes.length) continue;
    const det: FamilyDetection = {
      address: fo,
      rows: 1,
      cols: 1,
      format: w === 1 ? u8Fmt : u16Fmt,
      score: paramConfidence,
      tier: PARAM_TIER,
      kind: 'param',
    };
    if (w === 1) {
      // BYTE-DATA plain loads only (Decision 3). A word MOV (0xF2) site on a
      // mixed-evidence SA reads TWO bytes — its ≤0xFF word compares test a
      // 16-bit value, not this byte, and must never become a state.
      const imms = [
        ...new Set(
          ss
            .filter((s) => PLAIN_LOAD.has(s.op) && BYTE_DATA.has(s.op))
            .flatMap((s) => s.eqImms)
            .filter((v) => v <= 0xff)
        ),
      ].sort((a, b) => a - b);
      const stock = bytes[fo]!;
      const nonStock = imms.filter((v) => v !== stock);
      if (nonStock.length > 0) {
        det.states = [
          { name: `0x${stock.toString(16).toUpperCase().padStart(2, '0')} (stock)`, data: [stock] },
          ...nonStock.map((v) => ({ name: `0x${v.toString(16).toUpperCase().padStart(2, '0')}`, data: [v] })),
        ];
      }
    }
    out.push(det);
  }
  return out;
}
