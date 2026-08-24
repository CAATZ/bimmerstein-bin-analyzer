import { writable, type Writable } from 'svelte/store';
import type { AxisLibEntry, BinImage, EditJournal, MapDef, ValueFormat } from '@binanalyzer/core';
import type { Region, ScanProgress } from '@binanalyzer/engine';
import type { ChecksumReport } from '@binanalyzer/families';
import type { MapPack } from '@binanalyzer/formats';
import type { SaveOutcome } from '../lib/savereport.js';
import type { PackRow } from '../lib/packapply.js';

/**
 * Single source of truth (spec §7). Views subscribe;
 * ALL mutations go through ./actions.ts. Pure svelte/store — no Tauri, no DOM.
 */

export type ViewMode = 'hex' | '2d' | '3d' | 'map';

export interface ViewParams {
  format: ValueFormat;
  /** Cells per row in hexdump/2D (M/W keys). */
  columns: number;
  /** First displayed byte offset (Ctrl+←/→). */
  origin: number;
  /** Raw-value range driving hexdump value bars (Ctrl+B); null = format default. */
  valueRange: { min: number; max: number } | null;
  viewMode: ViewMode;
  previewOpen: boolean;
}

/** Byte range [start, end). cols = snapped/known column count; mapId set when the selection IS a map. */
export interface Selection {
  start: number;
  end: number;
  cols?: number;
  mapId?: string;
}

export type ScanState =
  | { state: 'idle' }
  | { state: 'running'; stage: ScanProgress['stage']; fraction: number }
  | { state: 'done' }
  | { state: 'canceled' }
  | { state: 'error'; message: string };

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

export const DEFAULT_VALUE_FORMAT: ValueFormat = { width: 1, signed: false, endianness: 'little' };

export const DEFAULT_VIEW_PARAMS: ViewParams = {
  format: DEFAULT_VALUE_FORMAT,
  columns: 16,
  origin: 0,
  valueRange: null,
  viewMode: 'hex',
  previewOpen: false,
};

export const bin: Writable<BinImage | null> = writable(null);
/**
 * The editable copy of the loaded bin. EVERY view reads this, never
 * `bin.bytes` — showing the original after an edit would render pre-edit data
 * while claiming to show the bin. `bin` stays the untouched original so its
 * sha256 remains the identity of the file on disk.
 *
 * The one deliberate exception is copilot/dispatch.ts, which transfers bytes
 * the agent verifies against that sha.
 */
export const workingBytes: Writable<Uint8Array | null> = writable(null);
/** Offsets edited since load. Empty ⇒ the buffer matches the file as opened. */
export const editJournal: Writable<EditJournal> = writable(new Map());
/**
 * Absolute path the loaded bin was read from, or null when it is unknown.
 * Session state, NOT identity: deliberately absent from BinImage and from the
 * project file (2026-08-01-mcp-copilot-design.md §5.2). The co-pilot uses it to
 * re-derive detections from the same bytes, and verifies the sha256 before
 * trusting it.
 */
export const binPath: Writable<string | null> = writable(null);
/**
 * Where this session's bytes were last successfully written, and what landed
 * there. `sha256` is READ BACK from the file, so "is the buffer dirty?" is a
 * hash comparison against a measured fact.
 *
 * Distinct from `binPath`, which is where the bin was LOADED from and is never
 * repointed by a save: the co-pilot resolves bytes by that path and verifies
 * them against `bin`'s identity.
 */
export interface SaveTarget {
  path: string;
  name: string;
  sha256: string;
  size: number;
}
export const saveTarget: Writable<SaveTarget | null> = writable(null);
/**
 * The `derivedFrom` of the project currently open, or null.
 *
 * PER-BIN state: cleared in setBin and resetStores alongside the rest. Lineage
 * describes an IMAGE, so carrying it across a bin swap would let a new image
 * inherit an ancestry it never had
 * (2026-08-24-project-lineage-design.md §4, §9).
 */
export const loadedLineage: Writable<{ name: string; sha256: string } | null> = writable(null);
/** The most recent save attempt — success or failure. Drives the report dialog and the status chip. */
export const lastSave: Writable<SaveOutcome | null> = writable(null);
/** User-confirmed maps (sorted by address). */
export const maps: Writable<MapDef[]> = writable([]);
/** Engine output, provenance 'auto' — ARRAY ORDER IS THE RANKING, never re-sort. */
export const potentialMaps: Writable<MapDef[]> = writable([]);
/** Axis Library (2026-07-29 shared-axis-library spec §5): per-project named axes stamped into maps. */
export const axisLibrary: Writable<AxisLibEntry[]> = writable([]);
export const regions: Writable<Region[]> = writable([]);
export const scanStatus: Writable<ScanState> = writable({ state: 'idle' });
export const viewParams: Writable<ViewParams> = writable({ ...DEFAULT_VIEW_PARAMS });
export const selection: Writable<Selection | null> = writable(null);
/** Monotonic scroll request — views jump so `offset` is visible (instant, spec §7). */
export const scrollRequest: Writable<{ offset: number; seq: number } | null> = writable(null);
export const toasts: Writable<Toast[]> = writable([]);
/** True while any modal dialog is open — App.svelte's keydown dispatcher checks this. */
export const modalOpen: Writable<boolean> = writable(false);

/** One change inside a proposal; `id` is the agent's, echoed back in the decision. */
export interface ProposedChange {
  id: string;
  /** change_map / change_axis_entry payload, or { addMap } for a definition import. */
  [field: string]: unknown;
}

export interface Proposal {
  requestId: string;
  title: string;
  reason?: string;
  changes: ProposedChange[];
}

/** Queued co-pilot proposals; the panel renders the head of this list. */
export const proposals: Writable<Proposal[]> = writable([]);

/** A pack awaiting the user's table-by-table decision; null when none is open. */
export interface PendingPack {
  pack: MapPack;
  rows: PackRow[];
  fileName: string;
}

/**
 * Cleared on every bin swap: the rows were classified against ONE image, and a
 * pack reviewed against a different one would show addresses and before-values
 * that are no longer true.
 */
export const pendingPack: Writable<PendingPack | null> = writable(null);

/**
 * The user's consent to share the session. OFF by default — this toggle IS the
 * consent gate (2026-08-01-mcp-copilot-design.md §4.5). It is a user
 * preference, so it deliberately survives a bin change.
 */
export const coPilotEnabled: Writable<boolean> = writable(false);

export type CoPilotStatus = 'off' | 'waiting' | 'connected' | 'disconnected';
export const coPilotStatus: Writable<CoPilotStatus> = writable('off');

export type AddressFrame = 'none' | 'ms41full';
/** How imported definition addresses were mapped into file offsets (2026-07-14 full-read def-frame spec). */
export const addressFrame: Writable<AddressFrame> = writable('none');
/** True once the full-read frame prompt has been answered (yes OR no) for the loaded bin — a decline sticks until a new bin is loaded. A confirm() FAILURE is not an answer. */
export const framePromptAnswered: Writable<boolean> = writable(false);

/** Checksum verdict for the loaded bin; undefined until a bin is loaded. */
export const checksumReport: Writable<ChecksumReport | undefined> = writable(undefined);

/** F11: show the ORIGINAL (pre-edit) value instead of the working one where edited (Task 8). */
export const showOriginal: Writable<boolean> = writable(false);

/**
 * Rectangular cell selection inside the shown map, or null. Inclusive bounds.
 * (r0,c0) is the anchor (where the drag/click started); (r1,c1) is the focus
 * (the far corner, or the same cell for a plain click) — shift-click moves the
 * focus while keeping the anchor. `cellsInRange` (actions.ts) normalises the
 * corners into the covered cells.
 *
 * Lives in the store, not view-local `$state`, because `App.svelte`'s global
 * `+`/`-` handlers need to read it too (2026-08-09 amendment: `MapView`'s old
 * component-local `selectedCell` could never bound a keypress dispatched from
 * outside the component).
 */
export interface CellRange {
  mapId: string;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}
export const cellRange: Writable<CellRange | null> = writable(null);
