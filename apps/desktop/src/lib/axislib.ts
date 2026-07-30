import type { AxisDef, AxisLibEntry, MapDef, Scaling, ValueFormat } from '@binanalyzer/core';

/**
 * Pure Axis Library helpers (2026-07-29 shared-axis-library spec §5).
 * lib/ contract: no Svelte/Tauri/DOM. The store's axis actions and the axis
 * dialogs consume these; keeping them here keeps components thin and testable.
 */

const formatKey = (f: ValueFormat | undefined): string =>
  JSON.stringify(f === undefined ? null : [f.width, f.signed, f.endianness, f.float === true]);

const scalingKey = (s: Scaling | undefined): string =>
  JSON.stringify(s === undefined ? null : [s.factor, s.offset, s.units, s.digits, s.rawExpression ?? null]);

/**
 * Identity triple for sharer suggestion and detected-axis dedup: equal
 * (address, count, format). Scaling is deliberately NOT part of this key —
 * the suggestion flow exists to UNIFY scaling on attach. (XDF's axisKey
 * includes scaling and stays the export-collapse authority.)
 */
export function axisIdentityKey(axis: AxisDef): string | undefined {
  if (axis.kind !== 'referenced' || axis.address === undefined || axis.format === undefined) return undefined;
  return `${axis.address}:${axis.count}:${formatKey(axis.format)}`;
}

/** The axis count a map slot requires — mirrors core validateMapDef exactly. */
export function slotCount(map: MapDef, slot: 'x' | 'y'): number {
  return slot === 'x'
    ? map.orientation === 'row-major' ? map.cols : map.rows
    : map.orientation === 'row-major' ? map.rows : map.cols;
}

/** Switch (states) maps cannot carry axes (core validateMapDef). */
export function mapAcceptsAxes(map: MapDef): boolean {
  return map.states === undefined;
}

/** The inline copy written into a map slot on attach: entry.name is authoritative. */
export function stampAxis(entry: AxisLibEntry): AxisDef {
  return { ...entry.axis, name: entry.name, libId: entry.id };
}

/** Same axis, stamp marker removed (detach / entry removal / dangling cleanup). */
export function detachedAxis(axis: AxisDef): AxisDef {
  const { libId: _libId, ...rest } = axis;
  return rest;
}

/** Entry-side normalization: the stored entry axis carries neither name nor libId. */
export function libraryAxis(axis: AxisDef): AxisDef {
  const { name: _name, libId: _libId, ...rest } = axis;
  return rest;
}

/**
 * D3 identity fields = everything except name: kind, address, count, values,
 * format, scaling. A local identity edit on an attached axis detaches it (the
 * caller strips libId); a pure rename does not.
 */
export function axisIdentityChanged(a: AxisDef, b: AxisDef): boolean {
  return (
    a.kind !== b.kind ||
    a.address !== b.address ||
    a.count !== b.count ||
    JSON.stringify(a.values ?? null) !== JSON.stringify(b.values ?? null) ||
    formatKey(a.format) !== formatKey(b.format) ||
    scalingKey(a.scaling) !== scalingKey(b.scaling)
  );
}

export interface AttachTarget {
  map: MapDef;
  slot: 'x' | 'y';
  /** true = lives in potentialMaps; attaching PROMOTES it first (spec §4). */
  potential: boolean;
  /** existing slot axis matches the entry's identity triple → pre-checked. */
  suggested: boolean;
  /** suggested, but scaling differs/missing — "will be unified on attach". */
  scalingDiffers: boolean;
  /** already stamped from this entry. */
  attached: boolean;
}

/** Dimension-filtered (map, slot) attach targets for one entry. */
export function attachTargets(entry: AxisLibEntry, confirmed: MapDef[], potentials: MapDef[]): AttachTarget[] {
  const key = axisIdentityKey(entry.axis);
  const out: AttachTarget[] = [];
  const push = (list: MapDef[], potential: boolean): void => {
    for (const map of list) {
      if (!mapAcceptsAxes(map)) continue;
      for (const slot of ['x', 'y'] as const) {
        if (slotCount(map, slot) !== entry.axis.count) continue;
        const existing = slot === 'x' ? map.xAxis : map.yAxis;
        const suggested = key !== undefined && existing !== undefined && axisIdentityKey(existing) === key;
        out.push({
          map,
          slot,
          potential,
          suggested,
          scalingDiffers: suggested && scalingKey(existing?.scaling) !== scalingKey(entry.axis.scaling),
          attached: existing?.libId === entry.id,
        });
      }
    }
  };
  push(confirmed, false);
  push(potentials, true);
  return out;
}

/** Confirmed-map slots stamped from this entry ("attached to N maps"). */
export function fanOutCount(entryId: string, confirmed: MapDef[]): number {
  let n = 0;
  for (const m of confirmed) {
    if (m.xAxis?.libId === entryId) n++;
    if (m.yAxis?.libId === entryId) n++;
  }
  return n;
}

/** "Save as axis" for a curve-shaped map: the curve's DATA span IS the axis. */
export function entryAxisFromCurve(map: MapDef): AxisDef {
  return {
    kind: 'referenced',
    address: map.address,
    count: Math.max(map.rows, map.cols),
    format: { ...map.format },
    scaling: { ...map.scaling },
  };
}
