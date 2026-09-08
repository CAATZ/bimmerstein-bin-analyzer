import type { ScanConfig } from '../../config.js';
import { MS41_CAL_SA_MAX, MS41_CAL_SA_MIN, saSpanContiguous, saToFo } from './frame.js';

/**
 * MS41 axis-pointer header decode (spec §4.6). Every stock 2-axis table is
 * immediately preceded by a 4-byte header `[xPtr u16 LE][yPtr u16 LE]` whose
 * pointers address the COUNT PREFIX of the table's x/y axes in cal SA space
 * (measured truth coverage: e36m3 61/61, s52 58/67 — the misses are SS1v2
 * custom 0x4000+ tables). Callers guarantee bytes.length >= MS41_MIN_BIN_LEN.
 */

export const readU8SA = (bytes: Uint8Array, sa: number): number => bytes[saToFo(sa)]!;
export const readU16SA = (bytes: Uint8Array, sa: number): number =>
  readU8SA(bytes, sa) | (readU8SA(bytes, sa + 1) << 8);

/**
 * Monotone shape of a validated axis run (v2.1, spec §4.6):
 * 'strict' = fully strictly monotone (the only shape the pre-v2.1 engine
 * accepted); 'plateau' = strictly-monotone prefix then a constant tail
 * repeating the last strict value, count INCLUDING the tail (the measured
 * SS1v2 custom-axis law, e.g. 0x3636: count 20 = 16 ascending u16 + 6437×4);
 * 'dead' = all cells equal (measured: MAF 0x2AD6's zero-filled axes).
 */
export type AxisRunKind = 'strict' | 'plateau' | 'dead';

export interface AxisPointerTarget {
  /** SA of the first axis CELL (the count prefix sits at `ptr`). */
  dataSA: number;
  count: number;
  width: 1 | 2;
  kind: AxisRunKind;
  /** Length of the strictly-monotone prefix (== count for 'strict', 1 for 'dead'). */
  strictLen: number;
}

export interface AxisPtrOpts {
  /**
   * Count floor override (default config.axis.minCount). The v2.1 header
   * path passes family.ms41.headerAxisMinCount; reader self-location keeps
   * the strict default.
   */
  minCount?: number;
  /** Accept 'plateau'/'dead' runs (default false: 'strict' only — the pre-v2.1 behavior). */
  relaxed?: boolean;
  /** A following axis prefix can disambiguate byte and word interpretations. */
  nextPtr?: number;
}

/**
 * Validate `ptr` as an axis count-prefix pointer: count within
 * [opts.minCount ?? config.axis.minCount, config.axis.maxCount] (u8 first,
 * unless a word run ends at the next axis prefix), the CELL run file-contiguous
 * and fully inside cal
 * (saSpanContiguous — a run crossing the SA 0x4000 seam would validate
 * against bytes downstream consumers never read), cells strictly monotone in
 * either direction — optionally with a constant plateau tail (opts.relaxed).
 * Strict defaults are byte-equivalent to the pre-v2.1 validator (proven by
 * the ss1 spike's R0 fidelity check: identical candidate sets on both bins).
 */
export function validateAxisPtr(
  bytes: Uint8Array,
  ptr: number,
  config: ScanConfig,
  opts?: AxisPtrOpts
): AxisPointerTarget | undefined {
  if (ptr < MS41_CAL_SA_MIN || ptr > MS41_CAL_SA_MAX - 4) return undefined;
  const minCount = opts?.minCount ?? config.axis.minCount;
  const relaxed = opts?.relaxed ?? false;
  const { maxCount } = config.axis;
  const widths: readonly (1 | 2)[] = ptr + 2 + readU16SA(bytes, ptr) * 2 === opts?.nextPtr ? [2, 1] : [1, 2];
  for (const width of widths) {
    const count = width === 1 ? readU8SA(bytes, ptr) : readU16SA(bytes, ptr);
    if (count < minCount || count > maxCount) continue;
    const dataSA = ptr + width;
    if (!saSpanContiguous(dataSA, count * width)) continue;
    const cell = (i: number): number =>
      width === 1 ? readU8SA(bytes, dataSA + i) : readU16SA(bytes, dataSA + i * 2);
    let dir = 0;
    let strictLen = 1;
    let broke = false;
    for (let i = 1; i < count; i++) {
      const d = Math.sign(cell(i) - cell(i - 1));
      if (d === 0) {
        strictLen = i;
        break;
      }
      if (dir !== 0 && d !== dir) {
        broke = true;
        break;
      }
      dir = d;
      strictLen = i + 1;
    }
    if (broke) continue;
    let tailOk = true;
    for (let i = strictLen; i < count; i++) {
      if (cell(i) !== cell(strictLen - 1)) {
        tailOk = false;
        break;
      }
    }
    if (!tailOk) continue;
    const kind: AxisRunKind = strictLen === count ? 'strict' : strictLen === 1 ? 'dead' : 'plateau';
    if (!relaxed && kind !== 'strict') continue;
    return { dataSA, count, width, kind, strictLen };
  }
  return undefined;
}

/** Established curve readers admit terminal plateaus after strict width resolution. */
export function validateCurveAxisPtr(bytes: Uint8Array, ptr: number, config: ScanConfig, minCount: number): AxisPointerTarget | undefined {
  const axis = validateAxisPtr(bytes, ptr, config, { minCount })
    ?? validateAxisPtr(bytes, ptr, config, { minCount, relaxed: true });
  return axis?.kind === 'dead' ? undefined : axis;
}
