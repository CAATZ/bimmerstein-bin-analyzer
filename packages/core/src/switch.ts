import type { MapDef } from './types.js';

/** A map is a SWITCH table iff it carries named states (spec 2026-07-23). */
export function isSwitch(map: Pick<MapDef, 'states'>): boolean {
  return map.states !== undefined;
}

/**
 * Read the switch's bytes from the bin and find the FIRST state (def order)
 * whose pattern matches EXACTLY. `map.address` is a FILE offset — 24KB cal
 * partials are direct-SA, and full-read imports are pre-framed by the app's
 * defframe flow, so no address mapping happens here. Bounds-guarded: bytes
 * past the end of the bin are omitted, so a truncated read NEVER matches (no
 * prefix matching) and callers can distinguish "outside the loaded region"
 * (actual.length < rows*cols*width) from "custom" (full read, no state
 * equal). Bounds-guarded also against a non-integer `map.address` — validation
 * only checks address >= 0, not integrality — so a fractional address reads
 * nothing rather than returning `undefined` array elements. Pure; never throws.
 */
export function matchSwitchState(bytes: Uint8Array, map: MapDef): { actual: number[]; matched?: string } {
  const size = map.rows * map.cols * map.format.width;
  const actual: number[] = [];
  if (Number.isInteger(map.address) && map.address >= 0) {
    const end = Math.min(map.address + size, bytes.length);
    for (let p = map.address; p < end; p++) actual.push(bytes[p]!);
  }
  if (actual.length !== size) return { actual };
  for (const s of map.states ?? []) {
    if (s.data.length === actual.length && s.data.every((b, i) => b === actual[i])) {
      return { actual, matched: s.name };
    }
  }
  return { actual };
}
