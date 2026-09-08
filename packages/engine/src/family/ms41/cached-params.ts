import type { ScanConfig } from '../../config.js';
import { instructionSuccessors, ms41Instructions, type ValueEvidence } from './consumers.js';
import { MS41_CAL_SA_MIN, MS41_CAL_SA_MAX, MS41_MIN_BIN_LEN, saToFo } from './frame.js';

const wordAt = (b: Uint8Array, p: number): number => b[p]! | (b[p + 1]! << 8);
const ram = (address: number): boolean => address >= 0xe000 && address < 0xf800;

/** Fixed-offset byte publications through agreed, code-established cached pointers. */
export function resolveMs41CachedBytes(bytes: Uint8Array, config: ScanConfig, consumers: Map<string, ValueEvidence>): number[] {
  if (bytes.length < MS41_MIN_BIN_LEN) return [];
  const instructions = ms41Instructions(bytes), predecessors = new Map<number, number[]>(), writers = new Map<number, Set<number>>();
  for (const pc of instructions) {
    for (const next of instructionSuccessors(bytes, pc)) {
      const group = predecessors.get(next) ?? []; group.push(pc); predecessors.set(next, group);
    }
    const op = bytes[pc]!, form = op & 15;
    if ([0xf6, 0xf7, 0xc5, 0xd5, 0x94, 0xb4].includes(op) || op < 0x80 && (form === 4 || form === 5)) {
      const address = wordAt(bytes, pc + 2), width = op === 0xf7 || op === 0xb4 || op < 0x80 && form === 5 ? 1 : 2;
      for (let a = address; a < address + width; a++) if (ram(a)) {
        const group = writers.get(a) ?? new Set<number>(); group.add(pc); writers.set(a, group);
      }
    }
  }
  const result = new Set<number>();
  for (const site of instructions) {
    if (bytes[site] !== 0xf4) continue;
    const operand = bytes[site + 1]!, dest = operand >> 4;
    const store = instructionSuccessors(bytes, site)[0]!;
    if (!instructions.has(store) || predecessors.get(store)?.length !== 1 || bytes[store] !== 0xf7 || bytes[store + 1] !== (0xf0 | dest)) continue;
    const mirror = wordAt(bytes, store + 2);
    if (!ram(mirror) || !consumers.get(`${mirror}:1`)?.used) continue;
    let remaining = config.family.ms41.consumerMaxInstructions, cached = false;
    function readWord(address: number, depth: number): number | undefined {
      if (--remaining < 0 || address % 2 !== 0) return undefined;
      if (address >= MS41_CAL_SA_MIN && address < MS41_CAL_SA_MAX) {
        const offset = saToFo(address);
        return offset + 1 < bytes.length ? wordAt(bytes, offset) : undefined;
      }
      if (!ram(address) || depth >= config.family.ms41.consumerMaxDepth) return undefined;
      const publications = new Set([...(writers.get(address) ?? []), ...(writers.get(address + 1) ?? [])]);
      if (!publications.size) return undefined;
      let value: number | undefined;
      for (const pc of publications) {
        if (bytes[pc] !== 0xf6 || (bytes[pc + 1]! >> 4) !== 0xf || wordAt(bytes, pc + 2) !== address) return undefined;
        const candidate = before(pc, bytes[pc + 1]! & 15, depth + 1);
        if (candidate === undefined || value !== undefined && candidate !== value) return undefined;
        value = candidate;
      }
      cached = true;
      return value;
    }
    function before(pc: number, reg: number, depth: number): number | undefined {
      while (--remaining >= 0) {
        const parents = predecessors.get(pc);
        if (parents?.length !== 1) return undefined;
        pc = parents[0]!;
        const op = bytes[pc]!, operand = bytes[pc + 1]!, hi = operand >> 4, lo = operand & 15;
        if (op === 0xe6 || op === 0xf2) {
          if (hi !== 0xf) return undefined;
          if (lo === reg) return op === 0xe6 ? wordAt(bytes, pc + 2) : readWord(wordAt(bytes, pc + 2), depth);
        } else if (op === 0xe0) {
          if (lo === reg) return hi;
        } else if (op === 0xf0) {
          if (hi === reg) reg = lo;
        } else if (op === 0xa8) {
          if (hi === reg) {
            const address = before(pc, lo, depth);
            return address === undefined ? undefined : readWord(address, depth);
          }
        } else if (op === 0xf3 || op === 0xe7 || op === 0xe1) {
          if ((op !== 0xe1 && hi !== 0xf) || (lo >> 1) === reg) return undefined;
        } else if (op === 0xf4 || op === 0xa9) {
          if ((hi >> 1) === reg) return undefined;
        } else if (op === 0xf6 || op === 0xf7) {
          // Direct IRAM/SFR writes can alias the current register bank or DPPs.
          if (wordAt(bytes, pc + 2) >= 0xfa00) return undefined;
        } else if (op !== 0xcc) return undefined;
      }
      return undefined;
    }
    const base = before(site, operand & 15, 0);
    if (base === undefined || !cached) continue;
    const sa = base + wordAt(bytes, site + 2);
    if (sa >= MS41_CAL_SA_MIN && sa <= MS41_CAL_SA_MAX && saToFo(sa) < bytes.length) result.add(sa);
  }
  return [...result].sort((a, b) => a - b);
}
