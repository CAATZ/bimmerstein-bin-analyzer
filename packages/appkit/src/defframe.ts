import type { AxisDef, MapDef } from '@binanalyzer/core';
import { MS41_MIN_BIN_LEN, foToSA, saSpanContiguous, saToFo } from '@binanalyzer/engine';

/**
 * Imported-definition address framing (spec 2026-07-14-fullread-def-frame-design).
 * A RomRaider storageaddress (SA) is a direct offset only into a 24KB CAL dump;
 * on a ≥0x18000 full read the cal bytes live at fo(SA) = (0x10000+SA)^0x4000.
 * frameDefMaps converts imported MapDefs SA→fo ONCE at import so the app keeps
 * its single file-offset address space; unframeDefMaps is the exact inverse for
 * RomRaider export. Pure (lib/ contract): no Svelte/Tauri/DOM.
 */

export interface FrameResult {
  maps: MapDef[];
  skipped: string[];
}

/** SAs live in the 24KB cal window. */
const SA_END = 0x6000;

export function isMs41FullRead(binSize: number): boolean {
  return binSize >= MS41_MIN_BIN_LEN;
}

const mapByteLen = (m: MapDef): number => m.rows * m.cols * m.format.width;
const axisByteLen = (a: AxisDef): number => a.count * (a.format?.width ?? 1);

/** In-cal + fo()-contiguous (no SA 0x4000 seam crossing; doubles as the cal-end cap). */
const saSpanOk = (sa: number, byteLen: number): boolean =>
  Number.isInteger(sa) && sa >= 0 && sa < SA_END && saSpanContiguous(sa, byteLen);

interface Remapped {
  map?: MapDef;
  error?: string;
}

/**
 * Remap one MapDef between SA space and file space. toFile=true: address IS an
 * SA, output saToFo(SA). toFile=false: address is a file offset; it must be a
 * saToFo fixpoint (i.e. inside a mapped cal chunk) — foToSA of any offset
 * outside the two cal chunks fails the round-trip check, which rejects manual
 * maps promoted from code regions without hardcoding window bounds here.
 */
function remapMap(m: MapDef, toFile: boolean): Remapped {
  const spans: Array<{ what: string; addr: number; len: number }> = [
    { what: 'data', addr: m.address, len: mapByteLen(m) },
  ];
  for (const [what, ax] of [['x axis', m.xAxis], ['y axis', m.yAxis]] as const) {
    if (ax !== undefined && ax.kind === 'referenced' && ax.address !== undefined) {
      spans.push({ what, addr: ax.address, len: axisByteLen(ax) });
    }
  }
  for (const s of spans) {
    const sa = toFile ? s.addr : foToSA(s.addr);
    if (!toFile && saToFo(sa) !== s.addr) {
      return { error: `${s.what} at 0x${s.addr.toString(16)} is outside the mapped cal window` };
    }
    if (!saSpanOk(sa, s.len)) {
      return { error: `${s.what} span 0x${sa.toString(16)}+${s.len} leaves the cal window or crosses the 0x4000 seam` };
    }
  }
  const convert = (addr: number): number => (toFile ? saToFo(addr) : foToSA(addr));
  const remapAxis = (ax: AxisDef | undefined): AxisDef | undefined =>
    ax !== undefined && ax.kind === 'referenced' && ax.address !== undefined
      ? { ...ax, address: convert(ax.address) }
      : ax;
  const out: MapDef = { ...m, address: convert(m.address) };
  const xa = remapAxis(m.xAxis);
  if (xa !== undefined) out.xAxis = xa;
  const ya = remapAxis(m.yAxis);
  if (ya !== undefined) out.yAxis = ya;
  return { map: out };
}

function run(maps: MapDef[], toFile: boolean): FrameResult {
  const out: MapDef[] = [];
  const skipped: string[] = [];
  for (const m of maps) {
    const r = remapMap(m, toFile);
    if (r.map !== undefined) out.push(r.map);
    else skipped.push(`${m.id} ("${m.name}"): ${r.error ?? 'not frameable'}`);
  }
  return { maps: out, skipped };
}

/** Import direction: definition SAs → file offsets (fo). */
export const frameDefMaps = (maps: MapDef[]): FrameResult => run(maps, true);

/** RomRaider-export direction: file offsets → definition SAs. Exact inverse of frameDefMaps. */
export const unframeDefMaps = (maps: MapDef[]): FrameResult => run(maps, false);

/**
 * True when a file-offset span has an exact RomRaider SA representation on a
 * full read: the offset is a saToFo fixpoint (inside a mapped cal chunk) and
 * the span stays in-cal + fo-contiguous — the same per-span rule
 * unframeDefMaps applies. Drives the Axis Library representability badge
 * (2026-07-29 shared-axis-library spec §5/§6).
 */
export function saRepresentableSpan(fileAddr: number, byteLen: number): boolean {
  const sa = foToSA(fileAddr);
  return saToFo(sa) === fileAddr && saSpanOk(sa, byteLen);
}

/** Badge predicate for an AxisDef: literal/index axes need no SA; referenced
 *  axes need their whole cell span representable. */
export function axisSaRepresentable(axis: AxisDef): boolean {
  if (axis.kind !== 'referenced' || axis.address === undefined) return true;
  return saRepresentableSpan(axis.address, axisByteLen(axis));
}
