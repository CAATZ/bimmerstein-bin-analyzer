import { get } from 'svelte/store';
import type { AxisDef, AxisLibEntry, BinImage, MapDef, Project, Result, Scaling, ValueFormat } from '@binanalyzer/core';
import { readValue, validateAxisLibEntry, validateMapDef } from '@binanalyzer/core';
import type { ScanProgress, ScanResult } from '@binanalyzer/engine';
import type { ChecksumReport } from '@binanalyzer/families';
import { checksumsFor } from '@binanalyzer/families';
import {
  DEFAULT_VIEW_PARAMS, addressFrame, axisLibrary, bin, binPath, checksumReport, framePromptAnswered, maps, modalOpen,
  potentialMaps,
  proposals, regions,
  scanStatus, scrollRequest, selection, toasts, viewParams,
  type Selection, type Toast, type ViewMode,
} from './stores.js';
import { detachedAxis, libraryAxis, stampAxis } from '../lib/axislib.js';
import { clearUndo, pushUndo, undoTransaction } from './undo.js';

/**
 * Every store mutation in the app lives here.
 * Pure (state, input) → state; unit-tested; no Tauri/DOM/engine calls.
 */

const VIEW_ORDER: ViewMode[] = ['hex', '2d', '3d', 'map'];
const MAX_COLUMNS = 256;

let toastSeq = 0;
let scrollSeq = 0;
let manualSeq = 0;
let modalDepth = 0;

export function pushToast(kind: Toast['kind'], text: string): number {
  const id = ++toastSeq;
  toasts.update((ts) => [...ts, { id, kind, text }]);
  return id;
}

export function dismissToast(id: number): void {
  toasts.update((ts) => ts.filter((t) => t.id !== id));
}

/** Modal dialogs (MapProperties, rom picker) call these from onMount/onDestroy
 *  so App.svelte's global keydown dispatcher can suspend itself while open —
 *  a depth counter (not a boolean) so two overlapping dialogs don't clear the
 *  trap when the first one closes. */
export function pushModal(): void {
  modalDepth++;
  modalOpen.set(true);
}

export function popModal(): void {
  modalDepth = Math.max(0, modalDepth - 1);
  modalOpen.set(modalDepth > 0);
}

export function requestScroll(offset: number): void {
  scrollRequest.set({ offset, seq: ++scrollSeq });
}

/** Test/reset hook — also the app-quit-to-blank state. */
export function resetStores(): void {
  bin.set(null);
  binPath.set(null);
  maps.set([]);
  potentialMaps.set([]);
  axisLibrary.set([]);
  regions.set([]);
  scanStatus.set({ state: 'idle' });
  selection.set(null);
  scrollRequest.set(null);
  toasts.set([]);
  viewParams.set({ ...DEFAULT_VIEW_PARAMS });
  addressFrame.set('none');
  framePromptAnswered.set(false);
  proposals.set([]);
  checksumReport.set(undefined);
  modalDepth = 0;
  modalOpen.set(false);
  clearUndo();
}

export function setBin(image: BinImage): void {
  bin.set(image);
  binPath.set(null); // a new bin: the caller records its path right after
  maps.set([]);
  potentialMaps.set([]);
  axisLibrary.set([]); // a new bin is a new address space — stale library entries would silently mis-decode
  regions.set([]);
  scanStatus.set({ state: 'idle' });
  selection.set(null);
  viewParams.set({ ...DEFAULT_VIEW_PARAMS });
  addressFrame.set('none'); // a new bin is a new frame decision
  framePromptAnswered.set(false);
  proposals.set([]); // a proposal is about maps in the bin that just went away
  clearUndo();
}

/** Records where the loaded bin came from. Call AFTER setBin, which clears it. */
export function setBinPath(path: string | null): void {
  binPath.set(path);
}

export function setChecksumReport(r: ChecksumReport | undefined): void {
  checksumReport.set(r);
}

/**
 * Verify the loaded bytes. Table-driven CRC over ~160 KB is single-digit
 * milliseconds, so this runs inline on load — no worker needed.
 */
export function runChecksumVerify(bytes: Uint8Array): void {
  const mod = checksumsFor(bytes);
  setChecksumReport(mod ? mod.verify(bytes) : undefined);
}

export function setScanRunning(): void {
  scanStatus.set({ state: 'running', stage: 'regions', fraction: 0 });
}

export function setScanProgress(stage: ScanProgress['stage'], fraction: number): void {
  scanStatus.set({ state: 'running', stage, fraction });
}

export function applyScanResult(result: ScanResult): void {
  regions.set(result.regions);
  potentialMaps.set(result.potentialMaps);
  scanStatus.set({ state: 'done' });
}

export function setScanError(message: string): void {
  scanStatus.set({ state: 'error', message });
  pushToast('error', `Scan failed: ${message} — views stay usable without detection`);
}

export function setScanCanceled(): void {
  scanStatus.set({ state: 'canceled' });
}

export function byteSpanOf(map: MapDef): { start: number; end: number } {
  return { start: map.address, end: map.address + map.rows * map.cols * map.format.width };
}

export function setSelection(start: number, end: number, cols?: number): void {
  if (end <= start) {
    selection.set(null);
    return;
  }
  const sel: Selection = { start, end };
  if (cols !== undefined) sel.cols = cols;
  selection.set(sel);
}

/** Sidebar click / F cycling: selection = the map's byte range + instant scroll (spec §7). */
export function selectMap(map: MapDef): void {
  const span = byteSpanOf(map);
  selection.set({ start: span.start, end: span.end, cols: map.cols, mapId: map.id });
  requestScroll(span.start);
}

const byAddress = (x: MapDef, y: MapDef): number => x.address - y.address || x.id.localeCompare(y.id);

export function promoteMap(id: string): boolean {
  const pots = get(potentialMaps);
  const found = pots.find((m) => m.id === id);
  if (!found) return false;
  // exactOptionalPropertyTypes: REMOVE confidence AND detector by destructuring —
  // both are valid only on 'auto' maps (core validateMapDef), never set undefined.
  const { confidence: _confidence, detector: _detector, ...rest } = found;
  const promoted: MapDef = { ...rest, provenance: 'manual' };
  pushUndo('promote map');
  potentialMaps.set(pots.filter((m) => m.id !== id));
  maps.update((ms) => [...ms, promoted].sort(byAddress));
  return true;
}

export function addMapFromSelection(): Result<MapDef> {
  const image = get(bin);
  if (!image) return { ok: false, error: 'no bin loaded' };
  const sel = get(selection);
  if (!sel) return { ok: false, error: 'no selection' };
  const vp = get(viewParams);
  const cols = sel.cols ?? vp.columns;
  const width = vp.format.width;
  const rows = Math.floor((sel.end - sel.start) / (cols * width));
  if (rows < 1) return { ok: false, error: `selection is smaller than one ${cols}-column row` };
  const map: MapDef = {
    id: `manual-0x${sel.start.toString(16)}-${++manualSeq}`,
    name: `Map 0x${sel.start.toString(16).toUpperCase()} ${rows}×${cols}`,
    address: sel.start,
    rows,
    cols,
    format: { ...vp.format },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major',
    provenance: 'manual',
  };
  const valid = validateMapDef(map, image.size);
  if (!valid.ok) return valid;
  pushUndo('create map');
  maps.update((ms) => [...ms, map].sort(byAddress));
  selection.set({ start: map.address, end: byteSpanOf(map).end, cols, mapId: map.id });
  return { ok: true, value: map };
}

/** K (spec §7): promote the selected potential map, else selection → manual map. */
export function confirmSelection(): void {
  const sel = get(selection);
  if (sel?.mapId !== undefined) {
    if (get(potentialMaps).some((m) => m.id === sel.mapId)) {
      promoteMap(sel.mapId);
      pushToast('info', 'Potential map promoted');
      return;
    }
    if (get(maps).some((m) => m.id === sel.mapId)) {
      pushToast('info', 'Selection is already a confirmed map');
      return; // K must not mint duplicates at the same address
    }
  }
  const r = addMapFromSelection();
  if (r.ok) pushToast('info', `Created ${r.value.name}`);
  else pushToast('error', `Cannot create map: ${r.error}`);
}

export function removeMap(id: string): void {
  if (!get(maps).some((m) => m.id === id)) return;
  pushUndo('remove map');
  maps.update((ms) => ms.filter((m) => m.id !== id));
  selection.update((sel) => (sel?.mapId === id ? null : sel));
}

export interface MapMetaPatch {
  name?: string;
  category?: string;
  scaling?: Scaling;
}

export function updateMapMeta(id: string, patch: MapMetaPatch): Result<MapDef> {
  const image = get(bin);
  if (!image) return { ok: false, error: 'no bin loaded' };
  const current = get(maps).find((m) => m.id === id);
  if (!current) return { ok: false, error: `no confirmed map with id ${id}` };
  const next: MapDef = { ...current };
  if (patch.name !== undefined && patch.name.trim() !== '') next.name = patch.name.trim();
  if (patch.category !== undefined) {
    if (patch.category.trim() === '') delete next.category;
    else next.category = patch.category.trim();
  }
  if (patch.scaling !== undefined) next.scaling = { ...patch.scaling };
  const valid = validateMapDef(next, image.size);
  if (!valid.ok) return valid;
  pushUndo('edit map properties');
  maps.update((ms) => ms.map((m) => (m.id === id ? next : m)));
  return { ok: true, value: next };
}

/**
 * The ONE map-axis mutator (2026-07-29 shared-axis-library spec §5): expresses
 * stamp, detach (libId-stripped copy), local edit, and remove (undefined).
 * Confirmed maps only — potentials are immutable; attach promotes first.
 */
export function setMapAxis(id: string, slot: 'x' | 'y', axis: AxisDef | undefined): Result<MapDef> {
  const image = get(bin);
  if (!image) return { ok: false, error: 'no bin loaded' };
  const current = get(maps).find((m) => m.id === id);
  if (!current) return { ok: false, error: `no confirmed map with id ${id}` };
  const key = slot === 'x' ? 'xAxis' : 'yAxis';
  const next: MapDef = { ...current };
  if (axis === undefined) delete next[key];
  else next[key] = { ...axis };
  const valid = validateMapDef(next, image.size);
  if (!valid.ok) return valid;
  pushUndo('change axis');
  maps.update((ms) => ms.map((m) => (m.id === id ? next : m)));
  return { ok: true, value: next };
}

export function addAxisLibEntry(name: string, axis: AxisDef, notes?: string): Result<AxisLibEntry> {
  const image = get(bin);
  if (!image) return { ok: false, error: 'no bin loaded' };
  const entry: AxisLibEntry = {
    id: crypto.randomUUID(),
    name: name.trim(),
    axis: libraryAxis(axis),
    ...(notes !== undefined && notes.trim() !== '' ? { notes: notes.trim() } : {}),
  };
  const valid = validateAxisLibEntry(entry, image.size);
  if (!valid.ok) return valid;
  pushUndo('add axis library entry');
  axisLibrary.update((es) => [...es, entry]);
  return { ok: true, value: entry };
}

export interface AxisLibEntryPatch {
  name?: string;
  axis?: AxisDef;
  notes?: string;
}

/** Entry-only update; re-stamping attached maps is separate and explicit (spec §4). */
export function updateAxisLibEntry(id: string, patch: AxisLibEntryPatch): Result<AxisLibEntry> {
  const image = get(bin);
  if (!image) return { ok: false, error: 'no bin loaded' };
  const current = get(axisLibrary).find((e) => e.id === id);
  if (!current) return { ok: false, error: `no axis library entry with id ${id}` };
  const next: AxisLibEntry = { ...current };
  if (patch.name !== undefined && patch.name.trim() !== '') next.name = patch.name.trim();
  if (patch.axis !== undefined) next.axis = libraryAxis(patch.axis);
  if (patch.notes !== undefined) {
    if (patch.notes.trim() === '') delete next.notes;
    else next.notes = patch.notes.trim();
  }
  const valid = validateAxisLibEntry(next, image.size);
  if (!valid.ok) return valid;
  pushUndo('edit axis library entry');
  axisLibrary.update((es) => es.map((e) => (e.id === id ? next : e)));
  return { ok: true, value: next };
}

/** Bulk detach: clears libId on every stamped slot; inline axes survive. */
export function detachAxisLibEntry(id: string): { detached: number } {
  return undoTransaction('detach axis library entry', () => {
    let detached = 0;
    for (const m of get(maps)) {
      for (const slot of ['x', 'y'] as const) {
        const ax = slot === 'x' ? m.xAxis : m.yAxis;
        if (ax?.libId === id) {
          const r = setMapAxis(m.id, slot, detachedAxis(ax));
          if (r.ok) detached++;
        }
      }
    }
    return { detached };
  });
}

export function removeAxisLibEntry(id: string): { removed: boolean; detached: number } {
  const exists = get(axisLibrary).some((e) => e.id === id);
  if (!exists) return { removed: false, detached: 0 };
  return undoTransaction('remove axis library entry', () => {
    const { detached } = detachAxisLibEntry(id);
    axisLibrary.update((es) => es.filter((e) => e.id !== id));
    return { removed: true, detached };
  });
}

/** Explicit "update N attached maps": per-map re-validate, skip+report (spec §4). */
export function restampAxisLibEntry(id: string): { updated: number; skipped: string[] } {
  const entry = get(axisLibrary).find((e) => e.id === id);
  if (!entry) return { updated: 0, skipped: [`no axis library entry with id ${id}`] };
  return undoTransaction('re-stamp axis library entry', () => {
    let updated = 0;
    const skipped: string[] = [];
    for (const m of get(maps)) {
      for (const slot of ['x', 'y'] as const) {
        const ax = slot === 'x' ? m.xAxis : m.yAxis;
        if (ax?.libId !== id) continue;
        const r = setMapAxis(m.id, slot, stampAxis(entry));
        if (r.ok) updated++;
        else skipped.push(`${m.id} ("${m.name}") ${slot}: ${r.error}`);
      }
    }
    return { updated, skipped };
  });
}

/** Spec §8: a MapDef in the store is always readable — out-of-range imports are skipped, not stored. */
export function addImportedMaps(imported: MapDef[]): { added: number; skipped: string[] } {
  const image = get(bin);
  if (!image) return { added: 0, skipped: imported.map((m) => `${m.name}: no bin loaded`) };
  const skipped: string[] = [];
  const good: MapDef[] = [];
  const ids = new Set(get(maps).map((m) => m.id));
  for (const m of imported) {
    const valid = validateMapDef(m, image.size);
    if (!valid.ok) {
      skipped.push(`${m.id} ("${m.name}"): ${valid.error}`);
      continue;
    }
    if (ids.has(m.id)) {
      skipped.push(`${m.id} ("${m.name}"): duplicate id`);
      continue;
    }
    ids.add(m.id);
    good.push(m);
  }
  if (good.length > 0) {
    pushUndo('import maps');
    maps.update((ms) => [...ms, ...good].sort(byAddress));
  }
  return { added: good.length, skipped };
}

export function adjustColumns(delta: number): void {
  viewParams.update((vp) => ({ ...vp, columns: Math.min(MAX_COLUMNS, Math.max(1, vp.columns + delta)) }));
}

export function shiftOrigin(delta: number): void {
  const image = get(bin);
  const max = image ? Math.max(0, image.size - 1) : 0;
  viewParams.update((vp) => ({ ...vp, origin: Math.min(max, Math.max(0, vp.origin + delta)) }));
}

export function setValueFormat(patch: Partial<ValueFormat>): void {
  viewParams.update((vp) => ({ ...vp, format: { ...vp.format, ...patch }, valueRange: null }));
}

export function cycleViewMode(delta: 1 | -1): void {
  viewParams.update((vp) => {
    const i = VIEW_ORDER.indexOf(vp.viewMode);
    return { ...vp, viewMode: VIEW_ORDER[(i + delta + VIEW_ORDER.length) % VIEW_ORDER.length]! };
  });
}

export function setViewMode(mode: ViewMode): void {
  viewParams.update((vp) => ({ ...vp, viewMode: mode }));
}

export function togglePreview(): void {
  viewParams.update((vp) => ({ ...vp, previewOpen: !vp.previewOpen }));
}

/** Ctrl+B (spec §7 "optimize value range"): min/max of the selection at the view word size. */
export function optimizeValueRange(): void {
  const image = get(bin);
  const sel = get(selection);
  if (!image || !sel) {
    pushToast('info', 'Ctrl+B optimizes the value range of the current selection — select a range first');
    return;
  }
  const vp = get(viewParams);
  const w = vp.format.width;
  const last = Math.min(sel.end, image.size) - w;
  if (last < sel.start) {
    pushToast('info', 'Selection is smaller than one cell at the current word size');
    return;
  }
  let min = Infinity;
  let max = -Infinity;
  for (let off = sel.start; off <= last; off += w) {
    const v = readValue(image.bytes, off, vp.format);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) max = min + 1;
  viewParams.update((p) => ({ ...p, valueRange: { min, max } }));
}

/** F / Shift+F (spec §7): cycle potential maps in ENGINE RANK order, wrap around. */
export function stepPotential(delta: 1 | -1): void {
  const pots = get(potentialMaps);
  if (pots.length === 0) {
    pushToast('info', 'No potential maps — run a scan first');
    return;
  }
  const sel = get(selection);
  let index = 0;
  if (sel?.mapId !== undefined) {
    const current = pots.findIndex((m) => m.id === sel.mapId);
    if (current >= 0) index = (current + delta + pots.length) % pots.length;
  }
  selectMap(pots[index]!);
}

export function projectSnapshot(): Result<Project> {
  const image = get(bin);
  if (!image) return { ok: false, error: 'no bin loaded — nothing to save' };
  const vp = get(viewParams);
  const frame = get(addressFrame);
  const lib = get(axisLibrary);
  return {
    ok: true,
    value: {
      schemaVersion: 2,
      bin: { name: image.name, sha256: image.sha256, size: image.size },
      valueDefaults: { ...vp.format },
      ...(frame === 'ms41full' ? { addressFrame: 'ms41full' as const } : {}),
      ...(lib.length > 0 ? { axisLibrary: lib } : {}),
      maps: get(maps),
      potentialMaps: get(potentialMaps),
    },
  };
}

export interface ApplyProjectReport {
  droppedMaps: string[];
  droppedPotentials: string[];
  droppedAxisEntries: string[];
  clearedStamps: string[];
}

export function applyProject(image: BinImage, project: Project): ApplyProjectReport {
  // Spec §8: a MapDef in the store is always readable. parseProject validated
  // against the RECORDED bin.size, but the user may have confirmed loading a
  // DIFFERENT (e.g. shorter) bin past the sha-mismatch gate — re-validate every
  // map AND library entry against the ACTUAL bytes, then clear stamps whose
  // entry is gone (dropped here, or already missing in the file).
  const keep = (list: MapDef[], dropped: string[]): MapDef[] =>
    list.filter((m) => {
      if (validateMapDef(m, image.size).ok) return true;
      dropped.push(`${m.id} ("${m.name}")`);
      return false;
    });
  const droppedMaps: string[] = [];
  const droppedPotentials: string[] = [];
  const droppedAxisEntries: string[] = [];
  const clearedStamps: string[] = [];
  const lib = (project.axisLibrary ?? []).filter((e) => {
    if (validateAxisLibEntry(e, image.size).ok) return true;
    droppedAxisEntries.push(`${e.id} ("${e.name}")`);
    return false;
  });
  const libIds = new Set(lib.map((e) => e.id));
  const clearDangling = (m: MapDef): MapDef => {
    let next = m;
    if (next.xAxis?.libId !== undefined && !libIds.has(next.xAxis.libId)) {
      clearedStamps.push(`${m.id} ("${m.name}") x`);
      next = { ...next, xAxis: detachedAxis(next.xAxis) };
    }
    if (next.yAxis?.libId !== undefined && !libIds.has(next.yAxis.libId)) {
      clearedStamps.push(`${m.id} ("${m.name}") y`);
      next = { ...next, yAxis: detachedAxis(next.yAxis) };
    }
    return next;
  };
  bin.set(image);
  axisLibrary.set(lib);
  maps.set(keep(project.maps, droppedMaps).map(clearDangling).sort(byAddress));
  potentialMaps.set(keep(project.potentialMaps, droppedPotentials).map(clearDangling)); // ENGINE RANK ORDER — never re-sort
  regions.set([]); // regions are scan output, not persisted — rescan restores dimming
  scanStatus.set({ state: 'idle' });
  selection.set(null);
  viewParams.set({ ...DEFAULT_VIEW_PARAMS, format: { ...project.valueDefaults } });
  addressFrame.set(project.addressFrame === 'ms41full' ? 'ms41full' : 'none');
  framePromptAnswered.set(false); // a project load brings a new bin — the frame prompt re-arms
  return { droppedMaps, droppedPotentials, droppedAxisEntries, clearedStamps };
}
