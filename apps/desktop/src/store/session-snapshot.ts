import { get } from 'svelte/store';
import { materialize, type AxisLibEntry, type BinImage, type EditJournal, type MapDef } from '@binanalyzer/core';
import type { Region } from '@binanalyzer/engine';
import {
  addressFrame, axisLibrary, bin, binPath, editJournal, framePromptAnswered, maps, potentialMaps,
  regions, scanStatus, selection, viewParams, workingBytes,
  type AddressFrame, type ScanState, type Selection, type ViewParams,
} from './stores.js';

/**
 * The whole session, as one value (2026-08-01-mcp-copilot-design.md §6.1).
 *
 * Deliberately NOT `Project`: a Project has seven keys and cannot carry
 * regions, scanStatus, selection, viewParams or framePromptAnswered, and
 * applyProject re-validates and DROPS maps — correct when loading a file from
 * disk, a data-loss hazard for undo. Within one session the bytes never change,
 * so a snapshot taken here was valid when taken and needs no re-validation.
 *
 * That premise is ENFORCED, not assumed: every path that swaps the loaded bin
 * (setBin, applyProject, resetStores) calls clearUndo, so no snapshot can
 * outlive the bytes it was captured against. Without that, undo would restore a
 * previous bin's session on top of the current one — and any per-bin store NOT
 * listed below (the checksum verdict) would stay on the new bin, leaving two
 * stores disagreeing about which file is loaded.
 *
 * Excluded on purpose: toasts, modalOpen and scrollRequest are transient UI, not
 * session state; restoring them would resurrect dismissed toasts and re-fire a
 * scroll.
 *
 * Also excluded, and for a different reason: saveTarget and lastSave. Those are
 * facts about the FILESYSTEM — "these bytes were written to this path and read
 * back with this hash" — and undoing an edit does not unwrite a file. Rewinding
 * them would make the app forget a file that still exists. Undo instead changes
 * whether the buffer still MATCHES the target, which `isDirty` recomputes from
 * the buffer's hash rather than from any stored flag.
 */
export interface SessionSnapshot {
  bin: BinImage | null;
  binPath: string | null;
  maps: MapDef[];
  potentialMaps: MapDef[];
  axisLibrary: AxisLibEntry[];
  regions: Region[];
  scanStatus: ScanState;
  viewParams: ViewParams;
  selection: Selection | null;
  addressFrame: AddressFrame;
  framePromptAnswered: boolean;
  /**
   * The edit journal, BY VALUE. workingBytes is deliberately NOT snapshotted:
   * edits mutate it in place, so a captured reference would see them and
   * restore nothing. The buffer is rebuilt from bin + this journal instead,
   * which also keeps a snapshot proportional to what changed rather than a
   * 256 KB copy per undo entry.
   */
  editJournal: EditJournal;
}

/**
 * Array copies are enough: every mutator in actions.ts replaces elements
 * immutably (spread-and-set), so no captured MapDef is ever edited in place and
 * snapshots share structure. Measured at 0.003 ms over a real 306-map session.
 */
export function captureSession(): SessionSnapshot {
  return {
    bin: get(bin),
    binPath: get(binPath),
    maps: [...get(maps)],
    potentialMaps: [...get(potentialMaps)],
    axisLibrary: [...get(axisLibrary)],
    regions: [...get(regions)],
    scanStatus: get(scanStatus),
    viewParams: { ...get(viewParams) },
    selection: get(selection),
    addressFrame: get(addressFrame),
    framePromptAnswered: get(framePromptAnswered),
    editJournal: new Map(get(editJournal)),
  };
}

export function restoreSession(s: SessionSnapshot): void {
  bin.set(s.bin);
  binPath.set(s.binPath);
  maps.set([...s.maps]);
  potentialMaps.set([...s.potentialMaps]);
  axisLibrary.set([...s.axisLibrary]);
  regions.set([...s.regions]);
  scanStatus.set(s.scanStatus);
  viewParams.set({ ...s.viewParams });
  selection.set(s.selection);
  addressFrame.set(s.addressFrame);
  framePromptAnswered.set(s.framePromptAnswered);
  editJournal.set(new Map(s.editJournal));
  workingBytes.set(s.bin === null ? null : materialize(s.bin.bytes, s.editJournal));
}
