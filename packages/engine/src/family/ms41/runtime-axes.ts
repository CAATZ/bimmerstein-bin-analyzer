import type { ScanConfig } from '../../config.js';
import { C166_OPCODE_LEN, type ReaderCall } from './c166.js';
import { readU16SA, validateCurveAxisPtr, type AxisPointerTarget } from './header.js';
import { cpuToFile } from './frame.js';
import { instructionSuccessors, ms41Instructions } from './consumers.js';

const wordAt = (b: Uint8Array, p: number): number => b[p]! | (b[p + 1]! << 8);
const ram = (a: number): boolean => a >= 0xe000 && a < 0xfe00;
const transfers = new Set([0xda, 0xca, 0xbb, 0xab, 0xfa, 0xea, 0x9c, 0xdb, 0xcb, 0xfb, 0x8a, 0x9a, 0xaa, 0xba]);
const fetches = new Set([0xa8, 0xa9, 0x98, 0x99, 0xd4, 0xf4]);

/** Curve axes established by descriptor staging on every bounded predecessor path. */
export function resolveMs41CurveAxes(bytes: Uint8Array, calls: ReaderCall[], readers: Map<number, 1 | 2>, config: ScanConfig): Map<number, AxisPointerTarget> {
  const { widthScanMaxInstr: prefixLimit, consumerMaxInstructions: limit, curveEmitMinCount: minCount } = config.family.ms41;
  const instructions = ms41Instructions(bytes);
  const predecessors = new Map<number, number[]>();
  for (const pc of instructions) for (const next of instructionSuccessors(bytes, pc)) {
    if (!instructions.has(next)) continue;
    const group = predecessors.get(next) ?? [];
    group.push(pc);
    predecessors.set(next, group);
  }
  const callAt = new Map(calls.map(call => [call.siteFile, call]));
  const stages = new Map<number, { width: 1 | 2; writes: Set<number> }>();
  const readerState = new Map<number, Set<number>>();
  for (const target of new Set(calls.map(call => call.targetCpu))) {
    let pc = cpuToFile(target), pointerReg = -1, width: 0 | 1 | 2 = 0;
    const writes = new Set<number>(), reads = new Set<number>();
    const countBytes = new Set<number>();
    const killWord = (reg: number): void => { countBytes.delete(reg * 2); countBytes.delete(reg * 2 + 1); };
    let fetched = false;
    for (let i = 0; i < prefixLimit && instructions.has(pc); i++) {
      const op = bytes[pc]!, b1 = bytes[pc + 1]!, lo = b1 & 0xf;
      if (transfers.has(op) || (op & 0xf) === 0xd) break;
      if (!fetched && (op === 0xf2 || op === 0xf3 || op === 0xc2 || op === 0xd2) && (b1 >> 4) === 0xf) {
        const addr = wordAt(bytes, pc + 2);
        if (ram(addr)) { reads.add(addr); if (op === 0xf2) reads.add(addr + 1); }
      }
      fetched ||= fetches.has(op);
      const hi = b1 >> 4, form = op & 0xf;
      if (pointerReg >= 0 && lo === pointerReg && (op === 0x98 || op === 0x99)) {
        width = op === 0x98 ? 2 : 1;
        const index = width === 2 ? hi * 2 : hi;
        if (index < 16) countBytes.add(index);
      } else if (op === 0xf1 || op === 0xf0) {
        const live = countBytes.has(op === 0xf1 ? lo : lo * 2);
        if (op === 0xf1) countBytes.delete(hi); else killWord(hi);
        const index = op === 0xf1 ? hi : hi * 2;
        if (live && index < 16) countBytes.add(index);
      } else if (op < 0x80 && form <= 9 && (op >> 4) !== 4 && form !== 4 && form !== 5) {
        const reg = form <= 1 || form >= 8 ? hi : lo;
        if (form & 1) countBytes.delete(reg); else killWord(reg);
      } else if ([0xe0, 0xe6, 0xf2, 0xc2, 0xd2, 0xc0, 0xd0].includes(op)) killWord(lo);
      else if ([0xe1, 0xe7, 0xf3].includes(op)) countBytes.delete(lo);
      else if (fetches.has(op)) {
        if (op === 0xa9 || op === 0x99 || op === 0xf4) countBytes.delete(hi); else killWord(hi);
      }
      pointerReg = op === 0xa8 && lo === 12 ? b1 >> 4 : -1;
      // The MS41 stagers publish a byte index derived from the loaded axis count.
      if (width && op === 0xf7 && hi === 0xf && countBytes.has(lo)) {
        const addr = wordAt(bytes, pc + 2);
        if (ram(addr)) writes.add(addr);
      }
      pc = instructionSuccessors(bytes, pc)[0]!;
    }
    if (width && writes.size) stages.set(target, { width, writes });
    if (readers.has(target) && reads.size) readerState.set(target, reads);
  }

  const results = new Map<number, AxisPointerTarget>(), unresolved = new Set<number>();
  for (const call of calls) {
    const state = readerState.get(call.targetCpu);
    if (!state) { if (readers.has(call.targetCpu)) unresolved.add(call.sa); continue; }
    let count = 0;
    const active = new Set<number>(), memo = new Map<number, AxisPointerTarget | undefined>();
    const same = (a: AxisPointerTarget, b: AxisPointerTarget): boolean => a.dataSA === b.dataSA && a.width === b.width && a.count === b.count;
    function resolve(pc: number): AxisPointerTarget | undefined {
      if (memo.has(pc)) return memo.get(pc);
      if (active.has(pc) || ++count > limit) return undefined;
      const op = bytes[pc]!, priorCall = callAt.get(pc);
      if (op === 0xda) {
        if (!priorCall || priorCall.sa < 4 || priorCall.sa > 0x5ffe) return undefined;
        const stage = stages.get(priorCall.targetCpu);
        if (!stage || ![...state!].every(addr => stage.writes.has(addr))) return undefined;
        const axis = validateCurveAxisPtr(bytes, readU16SA(bytes, priorCall.sa), config, minCount);
        return axis?.width === stage.width ? axis : undefined;
      }
      // Any unmodelled call or indirect store may replace interpolation state.
      if ([0xca, 0xbb, 0xab, 0x88, 0xc4, 0xe4, 0x84, 0xa4, 0xb8, 0xb9].includes(op)) return undefined;
      const form = op & 0xf;
      if (C166_OPCODE_LEN[op] === 4 && ((op < 0x80 && (form === 4 || form === 5)) || op === 0xf6 || op === 0xf7)) {
        const addr = wordAt(bytes, pc + 2), width = (op & 1) ? 1 : 2;
        if ([...state!].some(cell => cell >= addr && cell < addr + width)) return undefined;
      }
      const parents = predecessors.get(pc);
      if (!parents?.length) return undefined;
      active.add(pc);
      let axis: AxisPointerTarget | undefined;
      for (const parent of parents) {
        const candidate = resolve(parent);
        if (!candidate || (axis && !same(axis, candidate))) { axis = undefined; break; }
        axis = candidate;
      }
      active.delete(pc);
      memo.set(pc, axis);
      return axis;
    }
    let axis: AxisPointerTarget | undefined;
    for (const parent of predecessors.get(call.siteFile) ?? []) {
      const candidate = resolve(parent);
      if (!candidate || (axis && !same(axis, candidate))) { axis = undefined; break; }
      axis = candidate;
    }
    const previous = results.get(call.sa);
    if (!axis || (previous && !same(axis, previous))) unresolved.add(call.sa);
    else results.set(call.sa, axis);
  }
  for (const sa of unresolved) results.delete(sa);
  return results;
}
