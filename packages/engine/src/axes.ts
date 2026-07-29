import { readValue } from '@binanalyzer/core';
import type { ValueFormat } from '@binanalyzer/core';
import type { ScanConfig } from './config.js';
import type { Region } from './regions.js';

/**
 * Stage 2 — Axis candidate scan (spec §4.2).
 * Monotone runs (strict, either direction) in data regions across candidate
 * formats. All-equal runs rejected; 0/1-delta counter-like runs get a lower
 * prior. Implemented in plan Phase 2 (TDD).
 */
export interface AxisCandidate {
  address: number;
  count: number;
  format: ValueFormat;
  direction: 'inc' | 'dec';
  /** 0..1 */
  score: number;
}

/**
 * True when the `width` raw bytes starting at `offset` are uniformly 0x00 or
 * uniformly 0xFF — the same canonical fill-byte pattern regions.ts's Stage 1
 * classifier uses. Checked against raw bytes (not a decoded value) so this is
 * independent of signedness/endianness/interpretation.
 */
function isFillByteRun(bytes: Uint8Array, offset: number, width: number): boolean {
  if (offset < 0 || offset + width > bytes.length) return false;
  let allZero = true;
  let allFf = true;
  for (let k = 0; k < width; k++) {
    const b = bytes[offset + k]!;
    if (b !== 0x00) allZero = false;
    if (b !== 0xff) allFf = false;
  }
  return allZero || allFf;
}

export function scanAxes(bytes: Uint8Array, regions: Region[], config: ScanConfig): AxisCandidate[] {
  const { minCount, maxCount, candidateFormats, scoreCountDivisor, counterPenaltyFactor } = config.axis;
  const out: AxisCandidate[] = [];

  const emit = (format: ValueFormat, startAddr: number, values: number[], dir: 1 | -1): void => {
    const count = values.length;
    if (count < minCount || count > maxCount) return;
    let score = Math.min(1, count / scoreCountDivisor);
    const counterLike = values.every((v, i) => i === 0 || Math.abs(v - values[i - 1]!) === 1);
    if (counterLike) score *= counterPenaltyFactor;
    out.push({ address: startAddr, count, format, direction: dir > 0 ? 'inc' : 'dec', score });
  };

  for (const region of regions) {
    if (region.kind !== 'data') continue;
    for (const format of candidateFormats) {
      const w = format.width;

      for (let phase = 0; phase < w; phase++) {
        const base = region.start + phase;
        const cellCount = Math.floor((region.end - base) / w);
        if (cellCount < 2) continue;

        // Decode every cell at this byte phase up front so a maximal-run scan
        // can look one step back (plateau-tail detection, see below). Odd-
        // aligned axes are invisible at phase 0 — real cal layouts place
        // structures at arbitrary byte offsets (spec §4.2 scans "for each
        // candidate format"; the format's alignment is part of the candidate).
        const values: number[] = [];
        for (let i = 0; i < cellCount; i++) values.push(readValue(bytes, base + i * w, format));

        let i = 0;
        while (i < cellCount - 1) {
          const dir = Math.sign(values[i + 1]! - values[i]!) as -1 | 0 | 1;
          if (dir === 0) {
            i++;
            continue;
          }
          let j = i + 1;
          while (j < cellCount - 1) {
            const d = Math.sign(values[j + 1]! - values[j]!);
            if (d === dir) j++;
            else break;
          }
          // The run currently spans indices [i, j]. values[i] can end up as the
          // run's leading element merely because the direction sign flips
          // relative to whatever came before it (see the dir===0 skip above) —
          // that predecessor relationship is where the plan's reference fixture
          // trips up ("plateau-tail" false start). Coincidental numeric equality
          // between values[i] and values[i - 1] is NOT on its own a reliable
          // padding signal — real ECU axes can legitimately share a breakpoint
          // value with whatever precedes them (e.g. two tables both using a
          // 4000 RPM breakpoint), so trimming on value equality alone risks
          // silently amputating a genuine first sample. Instead, only trim
          // (at most) that single leading element, and only when the RAW BYTES
          // immediately preceding it are a canonical fill pattern — all 0x00 or
          // all 0xFF for the format's width — matching the same fill-byte
          // convention regions.ts uses for its Stage 1 empty-region classifier.
          // Checked against raw bytes (not decoded values) so a signed format's
          // decoded -1 (raw 0xFFFF) is recognized as fill regardless of numeric
          // value. This is a single-step trim, not a repeated walk-back: once
          // the immediate predecessor is fill, only the one element sitting on
          // the fill/run boundary is suspect, not however many further-back
          // elements happen to also be flat.
          const start = i < j && i > 0 && isFillByteRun(bytes, base + (i - 1) * w, w) ? i + 1 : i;
          emit(format, base + start * w, values.slice(start, j + 1), dir);
          i = j;
        }
      }
    }
  }
  return out;
}
