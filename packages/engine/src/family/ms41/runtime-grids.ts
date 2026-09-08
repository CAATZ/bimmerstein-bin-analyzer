import type { ScanConfig } from '../../config.js';
import type { FamilyDetection } from '../types.js';
import type { ReaderCall } from './c166.js';
import type { ReaderEntry } from './readers.js';
import { instructionSuccessors, ms41Instructions } from './consumers.js';
import { ms41AxisPrefixes } from './runtime-axes.js';
import { readU16SA, validateCurveAxisPtr, type AxisPointerTarget } from './header.js';
import { cpuToFile, MS41_CAL_SA_MIN, MS41_CAL_SA_MAX, saSpanContiguous, saToFo } from './frame.js';

const wordAt = (b: Uint8Array, p: number): number => b[p]! | (b[p + 1]! << 8);
const targetAt = (b: Uint8Array, p: number): number => (b[p + 1]! << 16) | wordAt(b, p + 2);
const ram = (a: number): boolean => a >= 0xe000 && a < 0xfe00;

/** Native row * stride + column addressing, with optional word-cell doubling. */
function gridState(b: Uint8Array, reader: ReaderEntry): { x: number[]; y: number[] } | undefined {
  const p = cpuToFile(reader.target);
  const prefix = [0xc2, 0xfa, null, null, 0xc2, 0xf1, null, null, 0x1b, 0xa1, 0xc2, 0xf1, null, null, 0x02, 0xf1, 0x0e, 0xfe];
  if (!prefix.every((v, i) => v === null || b[p + i] === v)) return undefined;
  let next = p + prefix.length;
  if (reader.width === 2) { if (wordAt(b, next) !== 0x1100) return undefined; next += 2; }
  if (wordAt(b, next) !== 0x1c00) return undefined;
  next += 2;
  if (reader.width === 1 && wordAt(b, next) === 0x09e1) next += 2;
  if (wordAt(b, next) !== (reader.width === 1 ? 0x81a9 : 0x41a8)) return undefined;
  const stride = wordAt(b, p + 2), y = wordAt(b, p + 6), x = wordAt(b, p + 12);
  return [stride, x, y].every(ram) && new Set([stride, x, y]).size === 3 ? { x: [x, stride], y: [y] } : undefined;
}

/** Only decoded register operations and disjoint direct stores preserve state. */
function preservesInstruction(b: Uint8Array, p: number, state: number[]): boolean {
  const op = b[p]!, operand = b[p + 1]!, form = op & 15;
  const disjoint = (addr: number, width: number): boolean => addr < 0xfe00 && state.every(a => a < addr || a >= addr + width);
  if ([0xf6, 0xf7, 0xc5, 0xd5, 0x94, 0xb4].includes(op) || (op < 0x80 && (form === 4 || form === 5))) {
    return disjoint(wordAt(b, p + 2), op === 0xf7 || op === 0xb4 || (op < 0x80 && form === 5) ? 1 : 2);
  }
  if (form === 0xe || form === 0xf) return operand < 0x80 && disjoint(0xfd00 + 2 * operand, 2);
  if ((form === 0xd) || [0xea, 0xfa, 0x8a, 0x9a, 0xcc, 0xdb, 0xcb].includes(op)) return true;
  if ([0xf0, 0xf1, 0xe0, 0xe1, 0xc0, 0xd0, 0xa8, 0xa9, 0x98, 0x99, 0xd4, 0xf4].includes(op)) return true;
  if ([0xe6, 0xe7, 0xf2, 0xf3, 0xc2, 0xd2].includes(op)) return (operand >> 4) === 0xf;
  if ([0x0b, 0x1b, 0x4b, 0x5b, 0x6b, 0x7b, 0x4c, 0x5c, 0x6c, 0x7c, 0x81, 0x91].includes(op)) return true;
  if (op < 0x80 && form <= 9) return [0, 1, 8, 9].includes(form) || (operand >> 4) === 0xf;
  return false;
}

function preservesR12(b: Uint8Array, p: number): boolean {
  const op = b[p]!, operand = b[p + 1]!, hi = operand >> 4, lo = operand & 15, form = op & 15;
  if ([0xf0, 0x81, 0x91].includes(op) || (op < 0x80 && form === 0 && op !== 0x40)) return hi !== 12;
  if ([0xe0, 0xe6, 0xf2, 0xc2, 0xd2, 0xc0, 0xd0, 0x4c, 0x5c, 0x6c, 0x7c].includes(op)) return lo !== 12;
  if (op < 0x80 && (form === 2 || form === 6) && op >> 4 !== 4) return operand !== 0xfc;
  if (op < 0x80 && form === 8 && op !== 0x48) return hi !== 12;
  if ([0xa8, 0x98, 0xd4].includes(op) && hi === 12) return false;
  return !([0x98, 0x99].includes(op) && lo === 12);
}

interface PathState {
  sa: number | undefined;
  x: AxisPointerTarget | undefined;
  y: AxisPointerTarget | undefined;
  argument: 'base' | 'x' | 'y' | 'none';
  width: 1 | 2;
  distance: number;
}

/** Resolve table bases and both staged axes together, retaining branch correlation. */
export function detectMs41RuntimeGrids(bytes: Uint8Array, calls: ReaderCall[], readers: ReaderEntry[], config: ScanConfig): FamilyDetection[] {
  const { consumerMaxInstructions: limit, consumerMaxDepth: depthLimit, maxR12Dist, headerAxisMinCount } = config.family.ms41;
  const instructions = ms41Instructions(bytes), predecessors = new Map<number, number[]>();
  for (const p of instructions) for (const next of instructionSuccessors(bytes, p)) {
    if (!instructions.has(next)) continue;
    const group = predecessors.get(next) ?? []; group.push(p); predecessors.set(next, group);
  }
  const { stages } = ms41AxisPrefixes(bytes, calls, new Map(), config, instructions);
  const contracts = new Map(readers.map(r => [r.target, { reader: r, state: gridState(bytes, r) }]));
  const preservation = new Map<string, boolean>();
  function preserves(target: number, state: number[], depth = 0): boolean {
    const key = `${target}/${state.join(',')}/${depth}`;
    if (preservation.has(key)) return preservation.get(key)!;
    if (depth > depthLimit) return false;
    const pending = [cpuToFile(target)], seen = new Set<number>();
    let returned = false;
    while (pending.length) {
      const p = pending.pop()!;
      if (seen.has(p)) continue;
      if (!instructions.has(p) || seen.size >= limit) return false;
      seen.add(p);
      if (bytes[p] === 0xda) {
        if (!preserves(targetAt(bytes, p), state, depth + 1)) return false;
      } else if (!preservesInstruction(bytes, p, state)) return false;
      if (bytes[p] === 0xdb || bytes[p] === 0xcb) returned = true;
      else pending.push(...instructionSuccessors(bytes, p));
    }
    preservation.set(key, returned);
    return returned;
  }
  const results = new Map<number, FamilyDetection>(), invalid = new Set<number>();
  for (const site of instructions) {
    if (bytes[site] !== 0xda) continue;
    const contract = contracts.get(targetAt(bytes, site));
    if (!contract?.state) continue;
    const { reader, state: cells } = contract;
    const resolved: PathState[] = [], seenBases = new Set<number>(), active = new Set<number>();
    let visited = 0;
    function walk(p: number, prior: PathState): boolean {
      if (++visited > limit || active.has(p)) return false;
      const s = { ...prior }, op = bytes[p]!;
      const needed = (): number[] => [...(s.x ? [] : cells!.x), ...(s.y ? [] : cells!.y)];
      if (op === 0xe6 && bytes[p + 1] === 0xfc && s.argument !== 'none') {
        const arg = wordAt(bytes, p + 2);
        if (s.distance > maxR12Dist || arg < MS41_CAL_SA_MIN || arg > MS41_CAL_SA_MAX - 1) return false;
        if (s.argument === 'base') { s.sa = arg; seenBases.add(arg); }
        else {
          if (arg % 2 !== 0) return false;
          const axis = validateCurveAxisPtr(bytes, readU16SA(bytes, arg), config, headerAxisMinCount);
          if (!axis || axis.width !== s.width || axis.dataSA % s.width !== 0) return false;
          s[s.argument] = axis;
        }
        s.argument = 'none';
      } else if (op === 0xda) {
        if (s.argument !== 'none') return false;
        const target = targetAt(bytes, p), stage = stages.get(target);
        const x = !s.x && cells!.x.every(a => stage?.writes.has(a));
        const y = !s.y && cells!.y.every(a => stage?.writes.has(a));
        if (x && y) return false;
        if (x || y) {
          if (!preserves(target, [...(!s.x && !x ? cells!.x : []), ...(!s.y && !y ? cells!.y : [])])) return false;
          s.argument = x ? 'x' : 'y'; s.width = stage!.width; s.distance = 0;
        } else if (!preserves(target, needed())) return false;
      } else {
        if (!preservesInstruction(bytes, p, needed())) return false;
        if (s.argument !== 'none' && !preservesR12(bytes, p)) return false;
        s.distance++;
      }
      if (s.sa !== undefined && s.x && s.y) { resolved.push(s); return true; }
      const parents = predecessors.get(p);
      if (!parents?.length) return false;
      active.add(p);
      // Visit every predecessor even after failure so known conflicting bases are retained.
      let ok = true;
      for (const parent of parents) if (!walk(parent, s)) ok = false;
      active.delete(p);
      return ok;
    }
    let ok = true;
    const parents = predecessors.get(site) ?? [];
    for (const p of parents) if (!walk(p, { sa: undefined, x: undefined, y: undefined, argument: 'base', width: reader.width, distance: 0 })) ok = false;
    if (!ok || !resolved.length) {
      for (const sa of seenBases) invalid.add(sa);
      for (const call of calls) if (call.siteFile === site) invalid.add(call.sa);
      continue;
    }
    for (const s of resolved) {
      const sa = s.sa!, x = s.x!, y = s.y!, length = x.count * y.count * reader.width;
      const { minRows, maxRows, minCols, maxCols } = config.table;
      if (sa % reader.width !== 0 || x.count < minCols || x.count > maxCols || y.count < minRows || y.count > maxRows || !saSpanContiguous(sa, length) || saToFo(sa) + length > bytes.length) { invalid.add(sa); continue; }
      const format = (width: 1 | 2) => ({ width, signed: false, endianness: 'little' as const });
      const table: FamilyDetection = {
        address: saToFo(sa), rows: y.count, cols: x.count, format: format(reader.width), score: 1, tier: 0,
        xAxis: { address: saToFo(x.dataSA), count: x.count, format: format(x.width) },
        yAxis: { address: saToFo(y.dataSA), count: y.count, format: format(y.width) },
      };
      const previous = results.get(sa);
      if (previous && JSON.stringify(previous) !== JSON.stringify(table)) invalid.add(sa);
      else results.set(sa, table);
    }
  }
  for (const sa of invalid) results.delete(sa);
  return [...results.values()].sort((a, b) => a.address - b.address);
}
