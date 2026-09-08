import type { ScanConfig } from '../../config.js';
import type { FamilyDetection } from '../types.js';
import type { ReaderCall } from './c166.js';
import type { ReaderEntry } from './readers.js';
import { instructionSuccessors, ms41Instructions } from './consumers.js';
import { ms41AxisPrefixes, ms41PreservingCalls, preservesMs41State } from './runtime-axes.js';
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
export function detectMs41RuntimeGrids(bytes: Uint8Array, calls: ReaderCall[], readers: ReaderEntry[], config: ScanConfig, fallbackAxes?: Map<number, FamilyDetection>): FamilyDetection[] {
  fallbackAxes?.clear();
  const { consumerMaxInstructions: limit, maxR12Dist, headerAxisMinCount } = config.family.ms41;
  const instructions = ms41Instructions(bytes), predecessors = new Map<number, number[]>();
  for (const p of instructions) for (const next of instructionSuccessors(bytes, p)) {
    if (!instructions.has(next)) continue;
    const group = predecessors.get(next) ?? []; group.push(p); predecessors.set(next, group);
  }
  const { stages } = ms41AxisPrefixes(bytes, calls, new Map(), config, instructions);
  const contracts = new Map(readers.map(r => [r.target, { reader: r, state: gridState(bytes, r) }]));
  const preserves = ms41PreservingCalls(bytes, instructions, config);
  const results = new Map<number, FamilyDetection>(), invalid = new Set<number>(), conflicting = new Set<number>();
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
        if (!preservesMs41State(bytes, p, needed())) return false;
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
      if (previous && JSON.stringify(previous) !== JSON.stringify(table)) { invalid.add(sa); conflicting.add(sa); }
      else results.set(sa, table);
    }
  }
  for (const sa of invalid) {
    const candidate = results.get(sa);
    // Incomplete call coverage can corroborate an existing fallback, never promote it.
    if (candidate && !conflicting.has(sa)) fallbackAxes?.set(candidate.address, candidate);
    results.delete(sa);
  }
  return [...results.values()].sort((a, b) => a.address - b.address);
}
