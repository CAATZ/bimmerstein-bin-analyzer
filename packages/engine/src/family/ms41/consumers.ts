import type { ScanConfig } from '../../config.js';
import type { ValueFormat } from '@binanalyzer/core';
import { C166_OPCODE_LEN, type ReaderCall } from './c166.js';
import { cpuToFile, inCalWindow } from './frame.js';

export interface ValueEvidence {
  used: boolean;
  signed: boolean;
  unsigned: boolean;
}

export interface ConsumerAnalysis {
  memory: Map<string, ValueEvidence>;
  tables: Map<number, ValueEvidence>;
}

const empty = (): ValueEvidence => ({ used: false, signed: false, unsigned: false });
function merge(into: ValueEvidence, from: ValueEvidence): void {
  into.used ||= from.used;
  into.signed ||= from.signed;
  into.unsigned ||= from.unsigned;
}

/** Preserve nonnegative representations: even sign extension also accepts positive unsigned data. */
export function supportsSignedStorage(bytes: Uint8Array, address: number, count: number, format: ValueFormat, evidence?: ValueEvidence): boolean {
  if (!evidence?.signed || evidence.unsigned) return false;
  const highByte = format.endianness === 'little' ? format.width - 1 : 0;
  for (let i = 0; i < count; i++) if ((bytes[address + i * format.width + highByte]! & 0x80) !== 0) return true;
  return false;
}

/** Instruction starts in the executable bank halves, in file order. */
export function ms41Instructions(bytes: Uint8Array): Set<number> {
  const starts = new Set<number>();
  for (let chunk = 0; chunk < bytes.length; chunk += 0x4000) {
    const start = chunk === 0x10000 ? 0x12000 : chunk;
    // CPU segment 0 at C000..FFFF executes RAM, not these scrambled flash bytes.
    if (inCalWindow(start) || chunk === 0x8000) continue;
    const end = Math.min(chunk + 0x4000, bytes.length);
    for (let p = start; p + 1 < end;) {
      const len = C166_OPCODE_LEN[bytes[p]!]!;
      if (p + (len || 2) > end) break;
      if (len) starts.add(p);
      p += len || 2;
    }
  }
  return starts;
}

const wordAt = (b: Uint8Array, p: number): number => b[p]! | (b[p + 1]! << 8);
const signedByte = (n: number): number => (n << 24) >> 24;
const returns = new Set([0xdb, 0xcb, 0xfb]);

/** Branch arithmetic is in CPU space: file bank halves are swapped. */
export function instructionSuccessors(b: Uint8Array, p: number): number[] {
  const op = b[p]!, len = C166_OPCODE_LEN[op]!;
  if (!len || returns.has(op) || op === 0x9c) return [];
  const cpu = cpuToFile(p);
  const relative = (disp: number): number => cpuToFile((cpu & ~0xffff) | ((cpu + len + disp * 2) & 0xffff));
  const next = relative(0);
  if ((op & 0xf) === 0xd) {
    const target = relative(signedByte(b[p + 1]!));
    return op === 0x0d ? [target] : [target, next];
  }
  if (op === 0x8a || op === 0x9a || op === 0xaa || op === 0xba) {
    return [relative(signedByte(b[p + 2]!)), next];
  }
  if (op === 0xfa) return [cpuToFile((b[p + 1]! << 16) | wordAt(b, p + 2))];
  if (op === 0xea) {
    const target = cpuToFile((cpu & ~0xffff) | wordAt(b, p + 2));
    return (b[p + 1]! >> 4) === 0 ? [target] : [target, next];
  }
  return [next];
}

const readMem = new Set([0x02, 0x03, 0x22, 0x23, 0x42, 0x43, 0x52, 0x53, 0x62, 0x63, 0x72, 0x73, 0xf2, 0xf3, 0xc2, 0xd2]);
const loads = new Set([0xf2, 0xf3, 0xc2, 0xd2]);
const ram = (addr: number): boolean => addr >= 0xe000 && addr < 0xfe00;
const keyFor = (addr: number, width: number): string => `${addr}:${width}`;

interface ReadSite { pc: number; op: number; reg: number; width: 1 | 2 }
interface TraceState { pc: number; words: number; bytes: number; compare: boolean; stack: number[] }

/** Bounded executable evidence; addresses in memory keys are logical, call sites are file offsets. */
export function analyzeMs41Consumers(
  bytes: Uint8Array, calls: ReaderCall[], readers: Map<number, 1 | 2>, config: ScanConfig
): ConsumerAnalysis {
  const { consumerMaxInstructions: limit, consumerMaxDepth: maxDepth } = config.family.ms41;
  const instructions = ms41Instructions(bytes);
  const sites = new Map<string, ReadSite[]>();
  for (const pc of instructions) {
    const op = bytes[pc]!, operand = bytes[pc + 1]!;
    if (!readMem.has(op) || (operand >> 4) !== 0xf) continue;
    const addr = wordAt(bytes, pc + 2);
    if (!(addr >= 4 && addr <= 0x5fff) && !ram(addr)) continue;
    const width = (op & 1) || op === 0xc2 || op === 0xd2 ? 1 : 2;
    const key = keyFor(addr, width), group = sites.get(key) ?? [];
    group.push({ pc, op, reg: operand & 0xf, width });
    sites.set(key, group);
  }
  const memo = new Map<string, ValueEvidence>();
  function memoryEvidence(key: string, depth: number): ValueEvidence {
    const memoKey = `${key}/${depth}`;
    const prior = memo.get(memoKey);
    if (prior) return prior;
    const evidence = empty();
    memo.set(memoKey, evidence);
    for (const site of sites.get(key) ?? []) {
      const { pc, op, reg, width } = site;
      const state: TraceState = { pc: instructionSuccessors(bytes, pc)[0]!, words: 0, bytes: 0, compare: false, stack: [] };
      if (loads.has(op)) {
        if (op === 0xf3) state.bytes = 1 << reg;
        else {
          state.words = 1 << reg;
          if (width === 1 && reg < 8) state.bytes = 1 << (2 * reg);
        }
        evidence.signed ||= op === 0xd2;
        evidence.unsigned ||= op === 0xc2;
      } else {
        evidence.used = true;
        state.compare = op === 0x42 || op === 0x43;
      }
      merge(evidence, trace(state, width, depth));
    }
    return evidence;
  }

  function trace(initial: TraceState, width: 1 | 2, depth: number): ValueEvidence {
    const evidence = empty(), pending = [initial], seen = new Set<string>();
    let count = 0;
    while (pending.length && count < limit) {
      const s = pending.pop()!;
      const { pc } = s;
      if ((!s.words && !s.bytes && !s.compare) || !instructions.has(pc)) continue;
      const stateKey = `${pc}/${s.words}/${s.bytes}/${+s.compare}/${s.stack.join(',')}`;
      if (seen.has(stateKey)) continue;
      seen.add(stateKey);
      count++;
      const op = bytes[pc]!, b1 = bytes[pc + 1]!, hi = b1 >> 4, lo = b1 & 0xf;
      const has = (byte: boolean, reg: number): boolean => !!((byte ? s.bytes : s.words) & (1 << reg));
      const kill = (byte: boolean, reg: number): void => {
        if (byte) { s.bytes &= ~(1 << reg); s.words &= ~(1 << (reg >> 1)); }
        else { s.words &= ~(1 << reg); if (reg < 8) s.bytes &= ~(3 << (2 * reg)); }
      };
      const copy = (byte: boolean, dest: number, live: boolean): void => {
        kill(byte, dest);
        if (live) {
          if (byte) s.bytes |= 1 << dest;
          else { s.words |= 1 << dest; if (width === 1 && dest < 8) s.bytes |= 1 << (2 * dest); }
        }
      };
      if ((op & 0xf) === 0xd || op === 0xea) {
        const cc = op === 0xea ? hi : op >> 4;
        if (s.compare) {
          evidence.used = true;
          evidence.signed ||= cc >= 0xa && cc <= 0xd;
          evidence.unsigned ||= cc === 8 || cc === 9 || cc === 0xe || cc === 0xf;
        }
      } else if (op === 0x8a || op === 0x9a || op === 0xfa || op === 0xcc) {
        // Bit branches and NOP do not rewrite the arithmetic condition codes.
      } else if (op === 0xaa || op === 0xba) {
        s.compare = false;
        if (b1 >= 0xf0) kill(false, lo);
      } else if (returns.has(op)) {
        evidence.used ||= has(false, 4) || has(true, 8);
        if (s.stack.length && op !== 0xfb) pending.push({ ...s, pc: s.stack.at(-1)!, stack: s.stack.slice(0, -1), compare: false });
        continue;
      } else if (op === 0xda) {
        const args = s.words & 0xf000;
        evidence.used ||= !!args;
        if (depth + s.stack.length < maxDepth) pending.push({ ...s, pc: cpuToFile((b1 << 16) | wordAt(bytes, pc + 2)), stack: [...s.stack, instructionSuccessors(bytes, pc)[0]!], compare: false });
        continue;
      } else if (op === 0xf0 || op === 0xf1) {
        const byte = op === 0xf1, live = has(byte, lo);
        evidence.used ||= live;
        copy(byte, hi, live);
        s.compare = false;
      } else if (op === 0xc0 || op === 0xd0) {
        const live = has(true, hi);
        evidence.used ||= live;
        evidence.signed ||= live && op === 0xd0;
        evidence.unsigned ||= live && op === 0xc0;
        copy(false, lo, live);
        s.compare = false;
      } else if ((op === 0xf6 || op === 0xf7) && hi === 0xf) {
        const byte = op === 0xf7, live = has(byte, lo), addr = wordAt(bytes, pc + 2);
        if (live) {
          evidence.used = true;
          const linkedDepth = depth + s.stack.length + 1;
          if (ram(addr) && width === (byte ? 1 : 2) && linkedDepth <= maxDepth) merge(evidence, memoryEvidence(keyFor(addr, width), linkedDepth));
        }
        s.compare = false;
      } else if (op === 0x88 || op === 0xc4 || op === 0xe4) {
        evidence.used ||= has(op === 0xe4, hi);
        if (op === 0x88) kill(false, lo);
        s.compare = false;
      } else if (op < 0x80 && (op & 0xf) <= 9) {
        const form = op & 0xf, byte = !!(form & 1), family = op >> 4;
        if (form >= 2 && form <= 7 && hi !== 0xf) continue;
        const reg = form === 0 || form === 1 || form === 8 || form === 9 ? hi : lo;
        const live = has(byte, reg) || ((form === 0 || form === 1) && has(byte, lo));
        evidence.used ||= live;
        s.compare = family === 4 && live;
        if (family !== 4 && form !== 4 && form !== 5) kill(byte, reg);
      } else if (loads.has(op) && hi === 0xf) {
        kill(op === 0xf3, lo);
        s.compare = false;
      } else if ((op === 0xe6 || op === 0xe7) && hi === 0xf || op === 0xe0 || op === 0xe1) {
        kill(op === 0xe1 || op === 0xe7, lo);
        s.compare = false;
      } else if ([0xa8, 0x98, 0xd4, 0xa9, 0x99, 0xf4].includes(op)) {
        kill(op === 0xa9 || op === 0x99 || op === 0xf4, hi);
        if (op === 0x98 || op === 0x99) kill(false, lo);
        s.compare = false;
      } else if ([0x4c, 0x5c, 0x6c, 0x7c, 0xac, 0xbc].includes(op)) {
        const dest = op === 0x5c || op === 0x7c || op === 0xbc ? lo : hi;
        evidence.used ||= has(false, dest);
        kill(false, dest);
        s.compare = false;
      } else if (op === 0x81 || op === 0xa1 || op === 0x91 || op === 0xb1) {
        const byte = op === 0xa1 || op === 0xb1;
        evidence.used ||= has(byte, hi);
        kill(byte, hi);
        s.compare = false;
      } else if (op === 0x0b || op === 0x1b) {
        evidence.used ||= has(false, hi) || has(false, lo);
        s.compare = false; // MUL/MULU write MDH/MDL, leaving the GPRs intact.
      } else if ((op & 0xf) === 0xe || (op & 0xf) === 0xf) {
        if (b1 >= 0xf0) kill(false, lo);
        s.compare = false;
      } else {
        // Unsupported register effects end evidence rather than preserving stale values.
        continue;
      }
      for (const next of instructionSuccessors(bytes, pc)) pending.push({ ...s, pc: next });
    }
    return evidence;
  }

  const memory = new Map<string, ValueEvidence>(), tables = new Map<number, ValueEvidence>();
  const tableWidths = new Map<number, number>(), conflicting = new Set<number>();
  for (const key of sites.keys()) memory.set(key, memoryEvidence(key, 0));
  for (const call of calls) {
    const width = readers.get(call.targetCpu);
    if (!width) continue;
    if (tableWidths.has(call.sa) && tableWidths.get(call.sa) !== width) conflicting.add(call.sa);
    tableWidths.set(call.sa, width);
    const evidence = tables.get(call.sa) ?? empty();
    merge(evidence, trace({ pc: instructionSuccessors(bytes, call.siteFile)[0]!, words: width === 2 ? 1 << 4 : 0, bytes: width === 1 ? 1 << 8 : 0, compare: false, stack: [] }, width, 0));
    tables.set(call.sa, evidence);
  }
  for (const sa of conflicting) tables.delete(sa);
  return { memory, tables };
}
