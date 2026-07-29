/**
 * MS41 file⇄CPU address frame law (family analyzer, spec §4.6). STRUCTURAL
 * constants of the MS41 memory map — facts, not tunable heuristics; they
 * change only if the hardware family changes, so they live here (tested),
 * not in config.ts.
 *
 * The 256KB full read has A14 inverted only in banks with CPU bit 16 set:
 *   file = cpu ^ 0x4000  for cpu in [0x10000,0x20000) ∪ [0x30000,0x40000)
 *   file = cpu           elsewhere.
 * Cal lives at CPU 0x10000+SA (DPP0=4), so fo(SA) = (0x10000+SA) ^ 0x4000.
 * Byte-verified (spike 2026-07-09, docs/notes/ms41-codexref-spike.md):
 * dispatcher FUN_024670 body found AT file 0x024670 (bank 2, direct);
 * cal-reader bodies at file = CPU ^ 0x4000 (e.g. 0x034ba6 → 0x030ba6).
 */
export const MS41_BANK_XOR = 0x4000;
/** Cal storageaddresses are offsets into the 24KB cal window. Min 4 leaves room for the 4-byte axis-pointer header. */
export const MS41_CAL_SA_MIN = 4;
export const MS41_CAL_SA_MAX = 0x5fff;
/** Minimum bin length for the frame law to address the cal window at all. */
export const MS41_MIN_BIN_LEN = 0x18000;

export const cpuToFile = (cpu: number): number => (cpu & 0x10000 ? cpu ^ MS41_BANK_XOR : cpu);
export const saToFo = (sa: number): number => (0x10000 + (sa & 0xffff)) ^ MS41_BANK_XOR;
export const foToSA = (fo: number): number => ((fo ^ MS41_BANK_XOR) - 0x10000) & 0xffff;
/** True when a file offset lies inside the frame-mapped cal window. */
export const inCalWindow = (fo: number): boolean =>
  (fo >= 0x10000 && fo < 0x12000) || (fo >= 0x14000 && fo < 0x18000);
/**
 * True when an SA-frame run of byteLen bytes starting at sa is CONTIGUOUS in
 * the file frame and stays inside cal. saToFo is contiguous everywhere except
 * the SA 0x3fff→0x4000 seam (fo 0x17fff→0x10000); downstream consumers (UI,
 * eval, exports) read tables/axes file-linearly, so a seam-crossing run would
 * silently read non-cal bytes. Doubles as a hard cal-bound extent cap.
 */
export const saSpanContiguous = (sa: number, byteLen: number): boolean =>
  sa < 0x4000 ? sa + byteLen <= 0x4000 : sa + byteLen <= 0x6000;
