import { writable, type Writable } from 'svelte/store';
import type { BinImage, MapDef, ValueFormat } from '@binanalyzer/core';
import type { Region, ScanProgress } from '@binanalyzer/engine';

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
/** User-confirmed maps (sorted by address). */
export const maps: Writable<MapDef[]> = writable([]);
/** Engine output, provenance 'auto' — ARRAY ORDER IS THE RANKING, never re-sort. */
export const potentialMaps: Writable<MapDef[]> = writable([]);
export const regions: Writable<Region[]> = writable([]);
export const scanStatus: Writable<ScanState> = writable({ state: 'idle' });
export const viewParams: Writable<ViewParams> = writable({ ...DEFAULT_VIEW_PARAMS });
export const selection: Writable<Selection | null> = writable(null);
/** Monotonic scroll request — views jump so `offset` is visible (instant, spec §7). */
export const scrollRequest: Writable<{ offset: number; seq: number } | null> = writable(null);
export const toasts: Writable<Toast[]> = writable([]);
/** True while any modal dialog is open — App.svelte's keydown dispatcher checks this. */
export const modalOpen: Writable<boolean> = writable(false);

export type AddressFrame = 'none' | 'ms41full';
/** How imported definition addresses were mapped into file offsets (2026-07-14 full-read def-frame spec). */
export const addressFrame: Writable<AddressFrame> = writable('none');
/** True once the full-read frame prompt has been answered (yes OR no) for the loaded bin — a decline sticks until a new bin is loaded. A confirm() FAILURE is not an answer. */
export const framePromptAnswered: Writable<boolean> = writable(false);
