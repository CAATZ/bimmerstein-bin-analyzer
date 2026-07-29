import type { ValueFormat } from '@binanalyzer/core';
import type { ScanConfig } from '../../config.js';
import { MS41_CAL_SA_MAX, MS41_CAL_SA_MIN, saToFo } from './frame.js';
import { validateAxisPtr } from './header.js';

/**
 * Minimal pool-axis shape the family fallback binds against — PrefixedAxis
 * minus `maximal` (structurally assignable). The plateau scan has no
 * maximality notion BY DESIGN: the measured FlexFuel x axis 0x35AE is
 * excluded from the generic pool only because its run continues into its
 * table's first byte.
 */
export interface FamilyPoolAxis {
  /** FILE offset of the first cell. */
  address: number;
  /** FILE offset one past the last cell. */
  end: number;
  count: number;
  format: ValueFormat;
}

const u8Fmt: ValueFormat = { width: 1, signed: false, endianness: 'big' };
const u16Fmt: ValueFormat = { width: 2, signed: false, endianness: 'little' };

/**
 * Family-internal plateau axis scan (v2.1, spec §4.6): sweep every cal SA for
 * count-prefixed axis runs tolerating a PLATEAU tail — strictly-monotone
 * prefix >= min(count, plateauStrictPrefixMin), constant tail repeating the
 * last strict value, count INCLUDING the tail (the measured SS1v2 custom-axis
 * law). Results feed ONLY the family fallback pool: `scanPrefixedAxes`, the
 * pool tier, and every pool threshold are untouched (pool-gate parity stays
 * byte-identical by construction). Measured: finds all 5 custom shared axes +
 * the FlexFuel x axis; noise (sub-runs, ~300 hits per real bin) is absorbed
 * by the fallback pair/extent machinery and span-dedup.
 */
export function scanPlateauCalAxes(bytes: Uint8Array, config: ScanConfig): FamilyPoolAxis[] {
  const { plateauAxisMinCount, plateauStrictPrefixMin } = config.family.ms41;
  const out: FamilyPoolAxis[] = [];
  for (let sa = MS41_CAL_SA_MIN; sa <= MS41_CAL_SA_MAX - 4; sa++) {
    const v = validateAxisPtr(bytes, sa, config, { minCount: plateauAxisMinCount, relaxed: true });
    if (!v || v.kind === 'dead') continue;
    if (v.strictLen < Math.min(v.count, plateauStrictPrefixMin)) continue;
    const address = saToFo(v.dataSA);
    out.push({
      address,
      end: address + v.count * v.width,
      count: v.count,
      format: v.width === 1 ? u8Fmt : u16Fmt,
    });
  }
  return out;
}
