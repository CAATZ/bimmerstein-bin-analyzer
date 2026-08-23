import { get } from 'svelte/store';
import type { AxisDef, AxisLibEntry, BinImage, MapDef, Project, Result, Scaling, ValueFormat } from '@binanalyzer/core';
import { applyEdit, changedOffsets, quantise, readAxisValues, readValue, revertOffsets, sha256Hex, toPhysical, validateAxisLibEntry, validateMapDef } from '@binanalyzer/core';
import type { ScanProgress, ScanResult } from '@binanalyzer/engine';
import type { ChecksumReport, FamilyChecksums } from '@binanalyzer/families';
import { checksumsFor } from '@binanalyzer/families';
import {
  DEFAULT_VIEW_PARAMS, addressFrame, axisLibrary, bin, binPath, cellRange, checksumReport, editJournal, framePromptAnswered,
  lastSave,
  maps,
  modalOpen,
  pendingPack,
  potentialMaps,
  proposals, regions,
  saveTarget,
  scanStatus, scrollRequest, selection, toasts, viewParams, workingBytes,
  type CellRange, type SaveTarget, type Selection, type Toast, type ViewMode,
} from './stores.js';
import type { SaveOutcome } from '../lib/savereport.js';
import type { PackTable } from '@binanalyzer/formats';
import type { PackRow } from '../lib/packapply.js';
import { detachedAxis, libraryAxis, stampAxis } from '../lib/axislib.js';
import { axisEditability, isMonotonic } from '../lib/axisedit.js';
import { clearUndo, pushUndo, redo as redoInternal, undo as undoInternal, undoTransaction } from './undo.js';

/**
 * Every store mutation in the app lives here.
 * Pure (state, input) → state; unit-tested; no Tauri/DOM/engine calls.
 */

const VIEW_ORDER: ViewMode[] = ['hex', '2d', '3d', 'map'];
const MAX_COLUMNS = 256;
/** correct()'s `changed` list is per BYTE, so corrections are laid down one byte at a time. */
const BYTE_FORMAT: ValueFormat = { width: 1, signed: false, endianness: 'little' };

let toastSeq = 0;
let scrollSeq = 0;
let manualSeq = 0;
let modalDepth = 0;

/**
 * The family checksum module resolved for the LOADED bin (I4, final
 * whole-branch review). Resolved ONCE, at load — an edit does not change
 * what family the image belongs to, even if it perturbs the checksum
 * module's own structural activation gate. `reverifyChecksums` re-verifies
 * with THIS module rather than re-resolving via `checksumsFor`, so a
 * gate-breaking edit produces an honest `applies: false` report instead of
 * making the checksum chip vanish.
 */
let activeChecksums: FamilyChecksums | undefined;

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
  pendingPack.set(null);
  checksumReport.set(undefined);
  activeChecksums = undefined;
  workingBytes.set(null);
  editJournal.set(new Map());
  saveTarget.set(null); // a new bin has never been saved — carrying a target over would overwrite another image's file
  lastSave.set(null);
  cellRange.set(null);
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
  pendingPack.set(null); // ditto: a pack was classified against the image that just went away
  checksumReport.set(undefined); // a new bin is a new checksum verdict — the old one would be fabricated data
  activeChecksums = undefined; // a new bin means a new (or no) family module — never carry the old one over
  workingBytes.set(Uint8Array.from(image.bytes)); // a new bin is a new working buffer
  editJournal.set(new Map());
  saveTarget.set(null); // a new bin has never been saved — carrying a target over would overwrite another image's file
  lastSave.set(null);
  cellRange.set(null); // a new bin is a new address space — a stale range's mapId would be meaningless
  clearUndo();
}

/** Records where the loaded bin came from. Call AFTER setBin, which clears it. */
export function setBinPath(path: string | null): void {
  binPath.set(path);
}

export function setSaveTarget(t: SaveTarget | null): void {
  saveTarget.set(t);
}

export function setLastSave(o: SaveOutcome | null): void {
  lastSave.set(o);
}

/**
 * Are there byte changes not yet on disk?
 *
 * Computed EXACTLY, on demand, and never cached in a flag: a flag set by every
 * mutation would still claim "unsaved" after undoing back to the state that was
 * saved. Hashing 256 KB costs low single-digit milliseconds and only happens
 * where the user is about to lose something — the three discard prompts and the
 * project-save warning.
 */
export function isDirty(): boolean {
  const working = get(workingBytes);
  if (working === null || get(editJournal).size === 0) return false;
  const t = get(saveTarget);
  return t === null || sha256Hex(working) !== t.sha256;
}

export function setChecksumReport(r: ChecksumReport | undefined): void {
  checksumReport.set(r);
}

/**
 * Verify the loaded bytes. Table-driven CRC over ~160 KB is single-digit
 * milliseconds, so this runs inline on load — no worker needed.
 *
 * Reads `bin` itself rather than taking a buffer parameter: both real callers
 * (flows.ts) already call this right after `setBin`/`applyProject` land the
 * image in the store, so an explicit parameter only invited a future caller
 * to pass the WORKING buffer instead of the original — silently re-resolving
 * and re-gating the family module against edited bytes, which is exactly
 * what `reverifyChecksums` exists to avoid.
 */
export function runChecksumVerify(): void {
  const image = get(bin);
  if (image === null) {
    activeChecksums = undefined;
    setChecksumReport(undefined);
    return;
  }
  activeChecksums = checksumsFor(image.bytes);
  setChecksumReport(activeChecksums ? activeChecksums.verify(image.bytes) : undefined);
}

/**
 * Re-verify against the CURRENT buffer — an edit can invalidate a checksum.
 *
 * Uses `activeChecksums` (resolved once, at load) rather than re-resolving
 * via `checksumsFor(working)`. `checksumsFor` re-runs the family's structural
 * ACTIVATION GATE against the edited bytes; an edit that perturbs the cal
 * descriptor can fail that gate even though the family of a loaded file does
 * not change because someone edited a table. Re-gating would make the
 * checksum chip vanish instead of turning red. `activeChecksums.verify`
 * still handles a gate-breaking edit correctly — it reports `applies: false`
 * rather than throwing — so the report is never fabricated, only honest.
 */
/**
 * Exported for the co-pilot's batch apply, which must verify ONCE after the
 * whole proposal rather than 200 times inside it. Zero-argument on purpose (the
 * B1 review's lesson): it reads `bin` internally, so no caller can hand it the
 * wrong buffer and re-gate the family module.
 */
export function reverifyChecksums(): void {
  const working = get(workingBytes);
  if (working === null) return setChecksumReport(undefined);
  setChecksumReport(activeChecksums ? activeChecksums.verify(working) : undefined);
}

export interface SaveCorrection {
  /** The bytes to write: the working buffer with the module's corrections applied. */
  bytes: Uint8Array;
  /** Describes `bytes`. undefined ⇒ no family module was active when this bin loaded. */
  report: ChecksumReport | undefined;
  changed: { offset: number; from: number; to: number }[];
  /** Journal keys BEFORE the correction: the user's own edits, not ours. */
  editedOffsets: number[];
}

/**
 * What a save WOULD write, computed without touching anything.
 *
 * `correct()` is pure and returns a new buffer, so the copy buys the property
 * the whole write path rests on: a cancelled dialog, a failed write or a
 * read-back mismatch leaves the session exactly as it was. The caller applies
 * the result only after the file is on disk and verified.
 *
 * Uses `activeChecksums` (resolved once, at load) rather than re-resolving:
 * re-gating the family module against edited bytes is the I4 hazard, and here
 * it would silently downgrade a recognised image to "written verbatim".
 */
export function correctForSave(): SaveCorrection | null {
  const working = get(workingBytes);
  if (working === null) return null;
  const editedOffsets = changedOffsets(get(editJournal));
  if (activeChecksums === undefined) {
    return { bytes: Uint8Array.from(working), report: undefined, changed: [], editedOffsets };
  }
  const c = activeChecksums.correct(working);
  return { bytes: c.bytes, report: c.report, changed: c.changed, editedOffsets };
}

/**
 * Land a verified save's checksum corrections in the working buffer.
 *
 * Goes through the ORDINARY edit path — `applyEdit` per byte, all inside ONE
 * `undoTransaction` — so the corrected bytes are journalled against the file as
 * opened (they show in the diff, because they genuinely differ from it), a save
 * is a single undo step, and no second notion of "changed bytes" exists to
 * disagree with the first.
 */
export function applySaveCorrection(changed: readonly { offset: number; to: number }[]): void {
  const working = get(workingBytes);
  const image = get(bin);
  if (working === null || image === null || changed.length === 0) return;
  undoTransaction('save correction', () => {
    const journal = get(editJournal);
    for (const ch of changed) {
      applyEdit({
        working,
        original: image.bytes,
        journal,
        offset: ch.offset,
        format: BYTE_FORMAT,
        raw: ch.to,
      });
    }
    workingBytes.set(working);
    editJournal.set(journal);
  });
  reverifyChecksums();
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

/** Byte offset of one grid cell, honouring orientation. Exported: the map view
 * needs it to ask whether a cell is in the diff. */
export function cellOffset(m: MapDef, row: number, col: number): number {
  const index = m.orientation === 'row-major' ? row * m.cols + col : col * m.rows + row;
  return m.address + index * m.format.width;
}

/**
 * Edit one cell to a PHYSICAL value. Returns what was actually stored so the
 * caller can redisplay it — the typed value is usually not exactly storable.
 */
export function editCell(
  m: MapDef,
  row: number,
  col: number,
  physical: number
): { ok: true; physical: number; clamped: boolean } | { ok: false; reason: string } {
  const image = get(bin);
  const working = get(workingBytes);
  if (image === null || working === null) return { ok: false, reason: 'No bin is loaded.' };
  const q = quantise(physical, m.scaling, m.format);
  if (!q.editable) {
    return { ok: false, reason: 'This map’s scaling factor is 0, so a physical value cannot be converted to a raw one.' };
  }
  const offset = cellOffset(m, row, col);
  if (offset < 0 || offset + m.format.width > working.length) {
    return { ok: false, reason: 'That cell lies outside the loaded bin.' };
  }
  pushUndo('edit cell');
  const journal = get(editJournal);
  applyEdit({ working, original: image.bytes, journal, offset, format: m.format, raw: q.stored });
  workingBytes.set(working);
  editJournal.set(journal);
  reverifyChecksums();
  return { ok: true, physical: q.physical, clamped: q.clamped };
}

export type RegionOp =
  | { kind: 'step'; steps: number }
  | { kind: 'percent'; percent: number }
  | { kind: 'set'; physical: number };

/**
 * Apply one operation across a set of cells as a SINGLE undo entry.
 *
 * `moved` counts cells whose stored byte actually changed — a small percentage
 * on a coarse table can round to no change, and saying "4 cells changed" when
 * none did would be a lie the user cannot see.
 */
export function applyRegionDelta(
  m: MapDef,
  cells: readonly { row: number; col: number }[],
  op: RegionOp
): { moved: number; clamped: number } {
  const image = get(bin);
  const working = get(workingBytes);
  if (image === null || working === null) return { moved: 0, clamped: 0 };
  let moved = 0;
  let clamped = 0;
  undoTransaction('edit region', () => {
    const journal = get(editJournal);
    for (const c of cells) {
      const offset = cellOffset(m, c.row, c.col);
      if (offset < 0 || offset + m.format.width > working.length) continue;
      const before = readValue(working, offset, m.format);
      const target =
        op.kind === 'step'
          ? toPhysical(before + op.steps, m.scaling)
          : op.kind === 'percent'
            ? toPhysical(before, m.scaling) * (1 + op.percent / 100)
            : op.physical;
      const q = quantise(target, m.scaling, m.format);
      if (!q.editable) continue;
      if (q.clamped) clamped++;
      if (q.stored === before) continue;
      applyEdit({ working, original: image.bytes, journal, offset, format: m.format, raw: q.stored });
      moved++;
    }
    workingBytes.set(working);
    editJournal.set(journal);
  });
  reverifyChecksums();
  return { moved, clamped };
}

/**
 * Edit one axis breakpoint. Same quantise path as a cell, using the AXIS's own
 * format and scaling. Warns — never blocks — when the result is not monotonic.
 */
export function editAxisValue(
  m: MapDef,
  which: 'x' | 'y',
  index: number,
  physical: number
): { ok: true; physical: number; clamped: boolean } | { ok: false; reason: string } {
  const axis = which === 'x' ? m.xAxis : m.yAxis;
  const can = axisEditability(axis);
  if (!can.editable) return { ok: false, reason: can.reason ?? 'This axis cannot be edited.' };
  const image = get(bin);
  const working = get(workingBytes);
  if (image === null || working === null) return { ok: false, reason: 'No bin is loaded.' };
  const format = axis!.format!;
  const scaling = axis!.scaling ?? { factor: 1, offset: 0, units: '', digits: 0 };
  const q = quantise(physical, scaling, format);
  if (!q.editable) return { ok: false, reason: 'This axis’s scaling factor is 0.' };
  const offset = axis!.address! + index * format.width;
  if (offset < 0 || offset + format.width > working.length) {
    return { ok: false, reason: 'That axis value lies outside the loaded bin.' };
  }
  pushUndo('edit axis value');
  const journal = get(editJournal);
  applyEdit({ working, original: image.bytes, journal, offset, format, raw: q.stored });
  workingBytes.set(working);
  editJournal.set(journal);
  reverifyChecksums();
  if (!isMonotonic(readAxisValues(working, axis!))) {
    pushToast('info', 'This axis is no longer in order. The ECU will still interpolate across it.');
  }
  return { ok: true, physical: q.physical, clamped: q.clamped };
}

/** One proposed byte edit, as it arrives from the co-pilot (Part C §4.1). */
export interface ProposedEdit {
  id: string;
  kind: 'cell' | 'axis';
  mapId: string;
  row?: number;
  col?: number;
  axis?: 'x' | 'y';
  index?: number;
  /** PHYSICAL unless `raw` is true. */
  value: number;
  raw?: boolean;
  /** The raw byte the agent based this edit on. */
  expectedRaw: number;
}

const IDENTITY_SCALING: Scaling = { factor: 1, offset: 0, units: '', digits: 0 };

function resolveEditTarget(
  m: MapDef,
  edit: ProposedEdit
): Result<{ offset: number; format: ValueFormat; scaling: Scaling }> {
  if (edit.kind === 'cell') {
    const row = edit.row ?? -1;
    const col = edit.col ?? -1;
    if (!Number.isInteger(row) || row < 0 || row >= m.rows) {
      return { ok: false, error: `row ${row} is outside this ${m.rows}x${m.cols} map` };
    }
    if (!Number.isInteger(col) || col < 0 || col >= m.cols) {
      return { ok: false, error: `col ${col} is outside this ${m.rows}x${m.cols} map` };
    }
    return { ok: true, value: { offset: cellOffset(m, row, col), format: m.format, scaling: m.scaling } };
  }
  const axis = edit.axis === 'y' ? m.yAxis : m.xAxis;
  const can = axisEditability(axis);
  if (!can.editable) return { ok: false, error: can.reason ?? 'That axis cannot be edited.' };
  const index = edit.index ?? -1;
  if (!Number.isInteger(index) || index < 0 || index >= axis!.count) {
    return { ok: false, error: `index ${index} is outside this ${axis!.count}-value axis` };
  }
  return {
    ok: true,
    value: {
      offset: axis!.address! + index * axis!.format!.width,
      format: axis!.format!,
      scaling: axis!.scaling ?? IDENTITY_SCALING,
    },
  };
}

/**
 * Apply ONE proposed byte edit.
 *
 * Called from the co-pilot dispatcher INSIDE the proposal's single
 * undoTransaction, so it neither opens its own transaction nor pushes its own
 * undo entry, and it does NOT re-verify checksums — the batch does that once
 * (Part C §6.1). It writes through the same applyEdit a human edit uses, so the
 * offset-keyed journal cannot tell the two apart, which is correct: the bytes
 * are the bytes.
 */
export function applyProposedEdit(
  edit: ProposedEdit
): Result<{ offset: number; stored: number; clamped: boolean }> {
  const image = get(bin);
  const working = get(workingBytes);
  if (image === null || working === null) return { ok: false, error: 'No bin is loaded.' };

  const m = get(maps).find((x) => x.id === edit.mapId) ?? get(potentialMaps).find((x) => x.id === edit.mapId);
  if (m === undefined) return { ok: false, error: `no map with id ${edit.mapId} in the app` };

  const target = resolveEditTarget(m, edit);
  if (!target.ok) return target;
  const { offset, format, scaling } = target.value;

  if (offset < 0 || offset + format.width > working.length) {
    return { ok: false, error: 'That value lies outside the loaded bin.' };
  }
  if (!Number.isInteger(edit.expectedRaw)) {
    return { ok: false, error: 'This edit carries no expectedRaw, so it cannot be checked against the buffer.' };
  }
  const current = readValue(working, offset, format);
  if (current !== edit.expectedRaw) {
    return {
      ok: false,
      error: `the byte moved since this was proposed: expected raw ${edit.expectedRaw}, found ${current}`,
    };
  }
  // raw:true rides the SAME path with identity scaling, so rounding and
  // clamping still apply and there is no second write path to keep honest.
  const q = quantise(edit.value, edit.raw === true ? IDENTITY_SCALING : scaling, format);
  if (!q.editable) {
    return { ok: false, error: 'This scaling factor is 0, so a physical value cannot be converted to a raw one.' };
  }

  const journal = get(editJournal);
  applyEdit({ working, original: image.bytes, journal, offset, format, raw: q.stored });
  workingBytes.set(working);
  editJournal.set(journal);
  return { ok: true, value: { offset, stored: q.stored, clamped: q.clamped } };
}

/**
 * The confirmed maps whose bytes this session edited, as pack tables.
 *
 * `values` come from the working buffer and `baseline` from the image as
 * opened, so a pack always records what the author started from (spec §2).
 * Only journal-touched maps qualify: exporting every confirmed map would ship
 * a stranger's whole calibration under the name of a tune.
 */
export function editedPackTables(): PackTable[] {
  const image = get(bin);
  const working = get(workingBytes);
  if (image === null || working === null) return [];
  const touched = new Set(get(editJournal).keys());
  if (touched.size === 0) return [];

  const out: PackTable[] = [];
  for (const m of get(maps)) {
    const { start, end } = byteSpanOf(m);
    let hit = false;
    for (let o = start; o < end; o++) {
      if (touched.has(o)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    const grid = (src: Uint8Array): number[][] => {
      const g: number[][] = [];
      for (let r = 0; r < m.rows; r++) {
        const row: number[] = [];
        for (let c = 0; c < m.cols; c++) row.push(readValue(src, cellOffset(m, r, c), m.format));
        g.push(row);
      }
      return g;
    };
    out.push({
      name: m.name,
      address: m.address,
      rows: m.rows,
      cols: m.cols,
      orientation: m.orientation,
      format: m.format,
      scaling: m.scaling,
      values: grid(working),
      baseline: grid(image.bytes),
    });
  }
  return out;
}

/**
 * Write the given pack rows into the working buffer.
 *
 * Rows are pre-classified (lib/packapply.ts); an `incompatible` one is never
 * written. The whole batch is ONE undoTransaction and ONE checksum re-verify,
 * so applying a pack is a single undo step and the checksum chip is never stale
 * mid-batch (map-packs spec §4.4). Values are RAW — the pack's scaling is for
 * display only and is deliberately not used here.
 *
 * The transaction is opened only once there is something to write, so a batch
 * with nothing applicable leaves no phantom undo step behind.
 */
export function applyPackRows(rows: readonly PackRow[]): { tables: number; changedBytes: number } {
  const image = get(bin);
  const working = get(workingBytes);
  if (image === null || working === null) return { tables: 0, changedBytes: 0 };

  interface Write {
    offset: number;
    format: ValueFormat;
    raw: number;
  }
  const plan: Write[] = [];
  let tables = 0;
  for (const row of rows) {
    if (row.klass === 'incompatible') continue;
    const t = row.table;
    const before = plan.length;
    for (const cell of row.cells) {
      if (cell.before === cell.after) continue;
      const i =
        t.orientation === 'row-major' ? cell.row * t.cols + cell.col : cell.col * t.rows + cell.row;
      const offset = row.address + i * t.format.width;
      if (offset < 0 || offset + t.format.width > working.length) continue;
      plan.push({ offset, format: t.format, raw: cell.after });
    }
    if (plan.length > before) tables++;
  }
  if (plan.length === 0) return { tables: 0, changedBytes: 0 };

  undoTransaction('apply map pack', () => {
    const journal = get(editJournal);
    for (const w of plan) {
      applyEdit({
        working,
        original: image.bytes,
        journal,
        offset: w.offset,
        format: w.format,
        raw: w.raw,
      });
    }
    workingBytes.set(working);
    editJournal.set(journal);
  });
  reverifyChecksums();
  return { tables, changedBytes: plan.length };
}

/** Plain click (1×1) or drag-select; `MapView` also passes the same anchor for shift-click extension. */
export function setCellRange(mapId: string, r0: number, c0: number, r1: number, c1: number): void {
  cellRange.set({ mapId, r0, c0, r1, c1 });
}

/** Clears the cell range — called when the shown map changes, so a stale range never survives it. */
export function clearCellRange(): void {
  cellRange.set(null);
}

/**
 * Normalises a range's corners (a drag up-and-left yields the same set as
 * down-and-right) and returns the covered cells in row-major order. `null`
 * (no range) yields no cells — callers fall back to their own default.
 */
export function cellsInRange(range: CellRange | null): { row: number; col: number }[] {
  if (range === null) return [];
  const rMin = Math.min(range.r0, range.r1);
  const rMax = Math.max(range.r0, range.r1);
  const cMin = Math.min(range.c0, range.c1);
  const cMax = Math.max(range.c0, range.c1);
  const cells: { row: number; col: number }[] = [];
  for (let row = rMin; row <= rMax; row++) {
    for (let col = cMin; col <= cMax; col++) cells.push({ row, col });
  }
  return cells;
}

/**
 * Which cells a region delta should touch for `m`.
 *
 * A range belonging to a DIFFERENT map is ignored rather than applied — the
 * view clears the range when the shown map changes, but this makes a stale
 * range harmless even if that clearing ever fails, which is the difference
 * between a cosmetic bug and editing cells the user never selected.
 * No range means no target: an accidental '+'/'-' must never rewrite an
 * entire table just because nothing was selected — callers must tell the
 * user to select a range first rather than fall back to "everything".
 */
export function cellsForDelta(m: MapDef, range: CellRange | null): { row: number; col: number }[] {
  if (range !== null && range.mapId === m.id) return cellsInRange(range);
  return [];
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
  const bytes = get(workingBytes) ?? image.bytes;
  let min = Infinity;
  let max = -Infinity;
  for (let off = sel.start; off <= last; off += w) {
    const v = readValue(bytes, off, vp.format);
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
  const t = get(saveTarget);
  return {
    ok: true,
    value: {
      schemaVersion: 2,
      // Spec §7: a project binds to the image as LAST SAVED, so reopening it
      // finds the tune it describes rather than the pristine file it came from.
      bin: t === null
        ? { name: image.name, sha256: image.sha256, size: image.size }
        : { name: t.name, sha256: t.sha256, size: t.size },
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
  checksumReport.set(undefined); // a new bin is a new checksum verdict — the old one would be fabricated data
  activeChecksums = undefined; // a new bin means a new (or no) family module — never carry the old one over
  workingBytes.set(Uint8Array.from(image.bytes)); // a new bin is a new working buffer
  editJournal.set(new Map());
  pendingPack.set(null); // a pack was classified against the image this one replaces
  saveTarget.set(null); // a new bin has never been saved — carrying a target over would overwrite another image's file
  lastSave.set(null);
  cellRange.set(null); // a new bin is a new address space — a stale range's mapId would be meaningless
  axisLibrary.set(lib);
  maps.set(keep(project.maps, droppedMaps).map(clearDangling).sort(byAddress));
  potentialMaps.set(keep(project.potentialMaps, droppedPotentials).map(clearDangling)); // ENGINE RANK ORDER — never re-sort
  regions.set([]); // regions are scan output, not persisted — rescan restores dimming
  scanStatus.set({ state: 'idle' });
  selection.set(null);
  viewParams.set({ ...DEFAULT_VIEW_PARAMS, format: { ...project.valueDefaults } });
  addressFrame.set(project.addressFrame === 'ms41full' ? 'ms41full' : 'none');
  framePromptAnswered.set(false); // a project load brings a new bin — the frame prompt re-arms
  clearUndo(); // ...and a new bin is a new address space: undoing across it would restore a foreign session
  return { droppedMaps, droppedPotentials, droppedAxisEntries, clearedStamps };
}

/** Restore the file-as-opened bytes at these offsets. */
export function revertOffsetsAction(offsets: readonly number[]): void {
  const working = get(workingBytes);
  if (working === null || offsets.length === 0) return;
  undoTransaction('revert', () => {
    const journal = get(editJournal);
    revertOffsets({ working, journal, offsets });
    workingBytes.set(working);
    editJournal.set(journal);
  });
  reverifyChecksums();
}

/** Restore every edited byte. */
export function revertAll(): void {
  revertOffsetsAction([...get(editJournal).keys()]);
}

/**
 * Undo/redo restore a whole session snapshot, including the working buffer —
 * wrapped here (rather than in undo.ts, which must not import this module)
 * so the ONE re-verify call covers both without duplicating the buffer-vs-
 * checksum wiring at each of App.svelte's two call sites.
 */
export function undo(): boolean {
  const did = undoInternal();
  if (did) reverifyChecksums();
  return did;
}

export function redo(): boolean {
  const did = redoInternal();
  if (did) reverifyChecksums();
  return did;
}
