import type { ScanConfig } from '../../config.js';
import { classifyReaderWidth, type ReaderCall } from './c166.js';
import { MS41_CAL_SA_MAX, MS41_CAL_SA_MIN } from './frame.js';
import { readU16SA, validateAxisPtr } from './header.js';
import { ms41Instructions } from './consumers.js';
import { ms41AxisPrefixes } from './runtime-axes.js';

export interface ReaderEntry {
  /** Callee CPU address. */
  target: number;
  /** Cell width the reader fetches (from its first fetch opcode). */
  width: 1 | 2;
}

/**
 * Truth-free cal-reader self-location (spec §4.6): rank CALLS targets by the
 * fraction of their DISTINCT cal-SA args whose preceding 4 bytes validate as
 * an axis-pointer header, keep targets with rate >= rateMin over >= minArgs
 * args and a classifiable fetch width. Measured (spike 2026-07-09): selects
 * exactly the true reader trio on both real bins (rates 67–100%) with the
 * next-best target <= 2%. Deterministic: output sorted by target ascending.
 */
export function selfLocateReaders(
  bytes: Uint8Array,
  calls: ReaderCall[],
  config: ScanConfig,
  minArgs: number,
  rateMin: number,
  widthScanMaxInstr: number
): ReaderEntry[] {
  const byTarget = new Map<number, Set<number>>();
  for (const c of calls) {
    if (c.sa < MS41_CAL_SA_MIN || c.sa > MS41_CAL_SA_MAX) continue;
    const set = byTarget.get(c.targetCpu) ?? new Set<number>();
    set.add(c.sa);
    byTarget.set(c.targetCpu, set);
  }
  const out: ReaderEntry[] = [];
  for (const [target, sas] of [...byTarget.entries()].sort((a, b) => a[0] - b[0])) {
    if (sas.size < minArgs) continue;
    let headerBacked = 0;
    for (const sa of sas) {
      if (
        validateAxisPtr(bytes, readU16SA(bytes, sa - 4), config) &&
        validateAxisPtr(bytes, readU16SA(bytes, sa - 2), config)
      )
        headerBacked++;
    }
    if (headerBacked / sas.size < rateMin) continue;
    const width = classifyReaderWidth(bytes, target, widthScanMaxInstr);
    if (width === 0) continue;
    out.push({ target, width });
  }
  return out;
}

/**
 * Self-locate CURVE readers (spec 2026-07-15 §Architecture.1). A curve reader's
 * distinct cal-SA args carry a valid 2-byte backward [axisPtr] header. A GRID's
 * 4-byte [xPtr][yPtr] header ALSO places a valid axis ptr at sa-2, so the bare
 * 2-byte test passes grids too — subtract the targets selfLocateReaders already
 * identifies as grid readers. Measured: leaves exactly the quartet 0x34a34/
 * 0x34ba6 (w1), 0x34a50/0x34bb2 (w2) on both real bins (minCount 2 & 4).
 */
export function selfLocateCurveReaders(
  bytes: Uint8Array,
  calls: ReaderCall[],
  config: ScanConfig
): Map<number, 1 | 2> {
  const {
    readerMinArgs,
    readerHeaderRateMin,
    widthScanMaxInstr,
    curveReaderMinArgs,
    curveReaderHeaderRateMin,
    curveAxisMinCount,
  } = config.family.ms41;
  const gridTrio = new Set(
    selfLocateReaders(bytes, calls, config, readerMinArgs, readerHeaderRateMin, widthScanMaxInstr).map(
      (r) => r.target
    )
  );
  const byTarget = new Map<number, Set<number>>();
  for (const c of calls) {
    if (c.sa < MS41_CAL_SA_MIN || c.sa > MS41_CAL_SA_MAX) continue;
    const s = byTarget.get(c.targetCpu) ?? new Set<number>();
    s.add(c.sa);
    byTarget.set(c.targetCpu, s);
  }
  const out = new Map<number, 1 | 2>();
  for (const [target, sas] of [...byTarget.entries()].sort((a, b) => a[0] - b[0])) {
    if (gridTrio.has(target)) continue; // grid reader — owned by the 2-axis tier
    if (sas.size < curveReaderMinArgs) continue;
    let hdr = 0;
    for (const sa of sas) {
      const ptr = readU16SA(bytes, sa - 2);
      if (ptr < sa && validateAxisPtr(bytes, ptr, config, { minCount: curveAxisMinCount })) hdr++;
    }
    if (hdr / sas.size < curveReaderHeaderRateMin) continue;
    const w = classifyReaderWidth(bytes, target, widthScanMaxInstr);
    if (w === 0) continue;
    out.set(target, w);
  }
  if (out.size) {
    // Descriptor stagers fetch pointers and publish axis counts, not curve cells.
    const { stages } = ms41AxisPrefixes(bytes, calls, out, config, ms41Instructions(bytes));
    for (const target of stages.keys()) out.delete(target);
  }
  return out;
}
