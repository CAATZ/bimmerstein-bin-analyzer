import {
  formatPhysical, quantise, readAxisValues, readValue, writeValue,
  type MapDef, type Scaling, type ValueFormat,
} from '@binanalyzer/core';
import { axisEditability, isMonotonic, mapsSharingAxis } from './axisedit.js';

/** A proposed edit as it arrives in a Proposal's `changes[]` (Part C §4.1). */
export interface PreviewInput {
  id: string;
  kind: 'cell' | 'axis';
  mapId: string;
  row?: number;
  col?: number;
  axis?: 'x' | 'y';
  index?: number;
  value: number;
  raw?: boolean;
  expectedRaw: number;
}

export interface EditPreviewRow {
  id: string;
  label: string;
  beforeRaw: number;
  afterRaw: number;
  beforePhysical: string;
  afterPhysical: string;
  /** Hit the format's representable limit; the limit is what will be stored. */
  clamped: boolean;
  /** Quantises onto the byte already there — accepting it moves nothing. */
  noChange: boolean;
  /** The current byte is no longer `expectedRaw`. */
  stale: boolean;
  /** Axis rows: the OTHER maps whose axes overlap these bytes. */
  shared: string[];
  /** Set when the target cannot be resolved at all. */
  error?: string;
}

export interface EditPreviewGroup {
  mapId: string;
  mapName: string;
  summary: string;
  rows: EditPreviewRow[];
}

const IDENTITY: Scaling = { factor: 1, offset: 0, units: '', digits: 0 };

interface Target {
  offset: number;
  format: ValueFormat;
  scaling: Scaling;
  label: string;
  shared: string[];
}

function findMap(mapId: string, maps: readonly MapDef[], potentials: readonly MapDef[]): MapDef | undefined {
  return maps.find((m) => m.id === mapId) ?? potentials.find((m) => m.id === mapId);
}

function resolve(m: MapDef, row: PreviewInput, allMaps: readonly MapDef[]): Target | string {
  if (row.kind === 'cell') {
    const r = row.row ?? -1;
    const c = row.col ?? -1;
    if (!Number.isInteger(r) || r < 0 || r >= m.rows) return `row ${r} is outside this ${m.rows}x${m.cols} map`;
    if (!Number.isInteger(c) || c < 0 || c >= m.cols) return `col ${c} is outside this ${m.rows}x${m.cols} map`;
    const index = m.orientation === 'row-major' ? r * m.cols + c : c * m.rows + r;
    return {
      offset: m.address + index * m.format.width,
      format: m.format,
      scaling: m.scaling,
      label: `cell [${r}, ${c}]`,
      shared: [],
    };
  }
  const which = row.axis === 'y' ? 'y' : 'x';
  const axis = which === 'x' ? m.xAxis : m.yAxis;
  const can = axisEditability(axis);
  if (!can.editable) return can.reason ?? 'that axis cannot be edited';
  const i = row.index ?? -1;
  if (!Number.isInteger(i) || i < 0 || i >= axis!.count) return `index ${i} is outside this ${axis!.count}-value axis`;
  return {
    offset: axis!.address! + i * axis!.format!.width,
    format: axis!.format!,
    scaling: axis!.scaling ?? IDENTITY,
    label: `${which.toUpperCase()} axis [${i}]`,
    // The fan-out is real: one breakpoint table serves every map pointing at
    // it. B1 showed this as the user began typing; a proposal's only chance to
    // show it is here, before the accept.
    shared: mapsSharingAxis(allMaps, axis!, m.id),
  };
}

// formatPhysical takes a RAW value and applies toPhysical itself. Passing it an
// already-converted physical value double-scales — the exact bug the 1D-curve
// Phase 2 work hit. Do not "fix" this by wrapping it in toPhysical.
const show = (raw: number, scaling: Scaling): string => formatPhysical(raw, scaling);

/**
 * Build what the panel renders. A DRY RUN: it calls quantise and reads the
 * buffer, and writes nothing — every flag below is computed, not promised.
 */
export function previewEdits(args: {
  rows: readonly PreviewInput[];
  maps: readonly MapDef[];
  potentials: readonly MapDef[];
  working: Uint8Array;
}): EditPreviewGroup[] {
  const { rows, maps, potentials, working } = args;
  const groups = new Map<string, EditPreviewGroup>();

  for (const row of rows) {
    const m = findMap(row.mapId, maps, potentials);
    let group = groups.get(row.mapId);
    if (group === undefined) {
      group = { mapId: row.mapId, mapName: m?.name ?? `unknown map ${row.mapId}`, summary: '', rows: [] };
      groups.set(row.mapId, group);
    }
    if (m === undefined) {
      group.rows.push(blank(row, `no map with id ${row.mapId} in the app`));
      continue;
    }
    const target = resolve(m, row, maps);
    if (typeof target === 'string') {
      group.rows.push(blank(row, target));
      continue;
    }
    const { offset, format, scaling, label, shared } = target;
    if (offset < 0 || offset + format.width > working.length) {
      group.rows.push(blank(row, 'that value lies outside the loaded bin'));
      continue;
    }
    const beforeRaw = readValue(working, offset, format);
    const q = quantise(row.value, row.raw === true ? IDENTITY : scaling, format);
    const afterRaw = q.editable ? q.stored : beforeRaw;
    group.rows.push({
      id: row.id,
      label,
      beforeRaw,
      afterRaw,
      beforePhysical: show(beforeRaw, scaling),
      afterPhysical: show(afterRaw, scaling),
      clamped: q.clamped,
      noChange: q.editable && afterRaw === beforeRaw,
      stale: beforeRaw !== row.expectedRaw,
      shared,
      ...(q.editable ? {} : { error: 'this scaling factor is 0, so a physical value cannot be converted' }),
    });
  }

  for (const group of groups.values()) group.summary = summarise(group.rows);
  return [...groups.values()];
}

function blank(row: PreviewInput, error: string): EditPreviewRow {
  const label =
    row.kind === 'cell'
      ? `cell [${row.row ?? '?'}, ${row.col ?? '?'}]`
      : `${(row.axis ?? 'x').toUpperCase()} axis [${row.index ?? '?'}]`;
  return {
    id: row.id, label,
    beforeRaw: 0, afterRaw: 0, beforePhysical: '—', afterPhysical: '—',
    clamped: false, noChange: false, stale: false, shared: [], error,
  };
}

function summarise(rows: readonly EditPreviewRow[]): string {
  const live = rows.filter((r) => r.error === undefined);
  if (live.length === 0) return `${rows.length} rows, none applicable`;
  const deltas = live.map((r) => r.afterRaw - r.beforeRaw);
  const lo = Math.min(...deltas);
  const hi = Math.max(...deltas);
  const sign = (n: number): string => `${n >= 0 ? '+' : ''}${n}`;
  const span = lo === hi ? sign(lo) : `${sign(lo)} to ${sign(hi)}`;
  const stale = live.filter((r) => r.stale).length;
  const idle = live.filter((r) => r.noChange).length;
  const notes = [stale > 0 ? `${stale} stale` : '', idle > 0 ? `${idle} no-op` : ''].filter((s) => s !== '');
  return `${live.length} value${live.length === 1 ? '' : 's'}, ${span} raw${notes.length > 0 ? ` — ${notes.join(', ')}` : ''}`;
}

/**
 * Labels of axes that would end up out of order if exactly `checkedIds` were
 * accepted. Computed over the CHECKED set, live, because accepting a subset is
 * a different axis from accepting all of them — and a dozen values is free to
 * recompute on every toggle.
 *
 * A non-monotonic axis warns; it never blocks (B1 §4).
 */
export function nonMonotonicAxes(args: {
  rows: readonly PreviewInput[];
  checkedIds: ReadonlySet<string>;
  maps: readonly MapDef[];
  potentials: readonly MapDef[];
  working: Uint8Array;
}): string[] {
  const { rows, checkedIds, maps, potentials, working } = args;
  const touched = new Map<string, { m: MapDef; which: 'x' | 'y' }>();
  const draft = working.slice();

  for (const row of rows) {
    if (row.kind !== 'axis' || !checkedIds.has(row.id)) continue;
    const m = findMap(row.mapId, maps, potentials);
    if (m === undefined) continue;
    const target = resolve(m, row, maps);
    if (typeof target === 'string') continue;
    const q = quantise(row.value, row.raw === true ? IDENTITY : target.scaling, target.format);
    if (!q.editable) continue;
    // core's writeValue, on a COPY. This module never touches the live buffer.
    writeValue(draft, target.offset, target.format, q.stored);
    touched.set(`${m.id}:${row.axis ?? 'x'}`, { m, which: row.axis === 'y' ? 'y' : 'x' });
  }

  const out: string[] = [];
  for (const { m, which } of touched.values()) {
    const axis = which === 'x' ? m.xAxis : m.yAxis;
    if (axis === undefined) continue;
    if (!isMonotonic(readAxisValues(draft, axis))) out.push(`${m.name} ${which.toUpperCase()} axis`);
  }
  return out;
}

/** True for a proposal row that moves BYTES rather than metadata. */
export function isEditRow(change: Record<string, unknown>): boolean {
  return change['kind'] === 'cell' || change['kind'] === 'axis';
}

/**
 * Everything checked, except stale and unresolvable rows. On a large batch
 * "accept it all" is the common case and unchecking a few is far less work than
 * checking them all — but a row whose premise no longer holds should take a
 * deliberate click.
 */
export function initialChecked(groups: readonly EditPreviewGroup[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const group of groups) {
    for (const row of group.rows) out[row.id] = !row.stale && row.error === undefined;
  }
  return out;
}
