import { get } from 'svelte/store';
import { createBinImage, sha256Hex } from '@binanalyzer/core';
import type { BinImage } from '@binanalyzer/core';
import {
  exportMapListCsv, exportMapListJson, exportRomRaiderXml, exportXdf, importRomRaiderXml, parsePack, parseProject,
  serializePack, serializeProject, type MapPack,
} from '@binanalyzer/formats';
import { identifyBin } from '@binanalyzer/families';
import * as actions from '../store/actions.js';
import { listRomIds } from '../lib/romlist.js';
import { addressFrame, bin, binPath, editJournal, framePromptAnswered, maps, pendingPack, potentialMaps, saveTarget, workingBytes } from '../store/stores.js';
import { classifyPack, packGateError } from '../lib/packapply.js';
import { frameDefMaps, isMs41FullRead, unframeDefMaps } from '@binanalyzer/appkit';
import { saveVerdict, verdictHeadline } from '../lib/savereport.js';
import { basename, dirname, joinPath, samePath, stemOf, type FileFilter, type PlatformHost } from './host.js';

/**
 * File-flow orchestration (spec §7 data flow, §8 error handling). Pure
 * against PlatformHost — every branch is unit-tested with a fake host.
 * Formats never throw (Result), host calls may — both funnel into toasts.
 */

const BIN_FILTERS: FileFilter[] = [
  { name: 'ECU binary', extensions: ['bin', 'ori', 'rom', 'dat'] },
  { name: 'All files', extensions: ['*'] },
];
const PROJECT_FILTERS: FileFilter[] = [{ name: 'BimmerStein Bin Analyzer project', extensions: ['binproj.json', 'json'] }];
const PACK_FILTERS: FileFilter[] = [{ name: 'Map pack', extensions: ['binpack.json', 'json'] }];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Ask before throwing away byte edits that are not on disk. Returns TRUE when
 * it is safe to proceed.
 *
 * Three callers, one dirty definition: the two choke points every bin load
 * passes through — loadBinFromPath (toolbar Open Bin AND the OS file drop) and
 * openProjectFlow, so there is exactly one prompt per load, never two — plus
 * confirmCloseFlow. Only the sentence naming the loss differs.
 */
async function confirmDiscard(host: PlatformHost, action: 'load' | 'close'): Promise<boolean> {
  if (!actions.isDirty()) return true;
  const n = get(editJournal).size;
  const what =
    action === 'load'
      ? 'Loading another image discards them.'
      : 'Closing the app discards them.';
  try {
    return await host.confirm(
      `This bin has ${n} unsaved byte change(s). ${what}\n` +
        `Save the bin first if you want to keep them. Discard and continue?`,
      'Unsaved changes'
    );
  } catch {
    // The two callers take OPPOSITE branches here, and each is the safe one for
    // its own action. Refusing to load keeps the edits. Refusing to CLOSE would
    // leave an app that cannot be quit because a dialog broke — worse than an
    // edit the user can redo, and they can always close again.
    return action === 'close';
  }
}

/**
 * The user asked to close the window. TRUE means the close may proceed.
 *
 * Same dirty definition and same prompt shape as the load guard (§8) — only the
 * sentence naming the loss differs, because the user is being asked about a
 * different one.
 */
export async function confirmCloseFlow(host: PlatformHost): Promise<boolean> {
  return await confirmDiscard(host, 'close');
}

export async function openBinFlow(host: PlatformHost): Promise<boolean> {
  const path = await host.openFile('Open ECU bin', BIN_FILTERS);
  if (path === null) return false;
  return loadBinFromPath(host, path);
}

export async function loadBinFromPath(host: PlatformHost, path: string): Promise<boolean> {
  if (!(await confirmDiscard(host, 'load'))) return false;
  try {
    const bytes = await host.readBinary(path);
    if (bytes.length === 0) {
      actions.pushToast('error', `${basename(path)} is empty`);
      return false;
    }
    actions.setBin(createBinImage(bytes, basename(path)));
    actions.setBinPath(path); // AFTER setBin — setBin clears it
    actions.runChecksumVerify(); // reads the bin the setBin call just landed
    return true;
  } catch (e) {
    actions.pushToast('error', `Cannot read ${basename(path)}: ${errText(e)}`);
    return false;
  }
}

// One save for the single-bin UI; scope by session if multiple tabs are added.
let binSaveInProgress = false;

/**
 * Write the edited image (spec 2026-08-11-binary-write-path §4). Resolves TRUE
 * only when a file was written AND read back with a matching hash.
 *
 * Step order is the safety property: prompt, refuse the source file, correct
 * PURELY, write, verify from disk, and only then update the originating session.
 * Corrections land only if its bytes still match the snapshot. A failed save
 * leaves the buffer, the journal and the save target exactly as they were.
 */
export async function saveBinFlow(
  host: PlatformHost,
  opts: { promptAlways: boolean }
): Promise<boolean> {
  if (binSaveInProgress) {
    actions.pushToast('info', 'A bin save is already in progress. Wait for it to finish.');
    return false;
  }
  binSaveInProgress = true;
  try {
    return await saveCurrentBin(host, opts);
  } finally {
    binSaveInProgress = false;
  }
}

async function saveCurrentBin(
  host: PlatformHost,
  opts: { promptAlways: boolean }
): Promise<boolean> {
  const image = get(bin);
  if (!image) {
    actions.pushToast('error', 'Open a bin first');
    return false;
  }
  const existing = get(saveTarget);
  const fail = (path: string | null, reason: string): false => {
    if (get(bin) === image) actions.setLastSave({ ok: false, path, reason });
    actions.pushToast('error', reason);
    return false;
  };

  let path: string | null;
  if (opts.promptAlways || existing === null) {
    const suggested = existing?.name ?? `${stemOf(image.name)}-edited.bin`;
    try {
      path = await host.saveFile('Save bin', suggested, BIN_FILTERS);
    } catch (e) {
      return fail(null, `Save failed: ${errText(e)}`);
    }
  } else {
    path = existing.path;
  }
  if (path === null) return false; // cancelled: not an outcome, nothing to report
  if (get(bin) !== image) return fail(path, 'Save cancelled because the loaded bin changed. Save the current bin again.');

  const source = get(binPath);
  if (source !== null && samePath(source, path)) {
    return fail(
      path,
      `${basename(path)} is the file this bin was opened from — save under a different name; the original is never overwritten.`
    );
  }

  const c = actions.correctForSave();
  if (c === null) return fail(path, 'Nothing to save — no working buffer');
  const before = sha256Hex(get(workingBytes)!);
  if (c.bytes.length !== image.size) {
    return fail(path, `Refusing to write ${c.bytes.length} bytes for a ${image.size}-byte image`);
  }

  try {
    await host.writeBinary(path, c.bytes);
  } catch (e) {
    return fail(path, `Save failed: ${errText(e)}`);
  }

  let onDisk: Uint8Array;
  try {
    onDisk = await host.readBinary(path);
  } catch (e) {
    return fail(path, `Wrote ${basename(path)} but could not read it back to verify: ${errText(e)}`);
  }
  const want = sha256Hex(c.bytes);
  if (sha256Hex(onDisk) !== want) {
    return fail(path, `${basename(path)} does not match what was written — do not flash it. Try a different location.`);
  }

  const verdict = saveVerdict({ report: c.report, editedOffsets: c.editedOffsets });
  if (get(bin) !== image) {
    actions.pushToast(
      verdict.kind === 'corrected' ? 'info' : 'error',
      `Saved ${basename(path)} from ${image.name}. ${verdictHeadline(verdict)} The currently loaded bin was left unchanged.`
    );
    return true;
  }

  // The verified file describes this snapshot, even if newer edits arrived during I/O.
  const current = get(workingBytes);
  const unchanged = current !== null && sha256Hex(current) === before;
  if (unchanged) actions.applySaveCorrection(c.changed);
  actions.setSaveTarget({ path, name: basename(path), sha256: want, size: c.bytes.length });
  actions.setLastSave({
    ok: true,
    path,
    name: basename(path),
    size: c.bytes.length,
    sha256: want,
    verdict,
    corrected: c.changed,
    report: c.report,
    editedBytes: c.editedOffsets.length,
  });
  // The toast half of §6; the modal half is the caller's, driven by isModalOutcome.
  if (!unchanged) {
    actions.pushToast('error', `Saved ${basename(path)}, but newer edits were not saved. They remain in the editor; save again to include them.`);
  } else if (verdict.kind === 'corrected') {
    actions.pushToast('info', `Saved ${basename(path)} — ${verdictHeadline(verdict)}`);
  }
  return true;
}

/**
 * Resolves TRUE only when a project file was actually written. The co-pilot
 * link reports this verbatim (spec §7.3): a cancelled dialog or a failed write
 * must reach the agent as `rejected`, never as a save that happened.
 */
export async function saveProjectFlow(host: PlatformHost): Promise<boolean> {
  const snap = actions.projectSnapshot();
  if (!snap.ok) {
    actions.pushToast('error', snap.error);
    return false;
  }
  const path = await host.saveFile('Save project', `${stemOf(snap.value.bin.name)}.binproj.json`, PROJECT_FILTERS);
  if (path === null) return false;
  try {
    await host.writeText(path, serializeProject(snap.value));
    actions.pushToast('info', `Project saved to ${basename(path)}`);
    if (actions.isDirty()) {
      // A project binds to a FILE (spec §7). If the bytes on screen are not that
      // file's bytes, say so rather than let the user assume otherwise.
      actions.pushToast(
        'error',
        `The bin has unsaved byte changes — this project records ${snap.value.bin.name} as last saved, not what is on screen. Save the bin to keep them in step.`
      );
    }
    return true;
  } catch (e) {
    actions.pushToast('error', `Save failed: ${errText(e)}`);
    return false;
  }
}

export async function openProjectFlow(host: PlatformHost): Promise<void> {
  if (!(await confirmDiscard(host, 'load'))) return;
  const projPath = await host.openFile('Open project', PROJECT_FILTERS);
  if (projPath === null) return;
  let text: string;
  try {
    text = await host.readText(projPath);
  } catch (e) {
    actions.pushToast('error', `Cannot read project: ${errText(e)}`);
    return;
  }
  const parsed = parseProject(text);
  if (!parsed.ok) {
    actions.pushToast('error', `Invalid project: ${parsed.error}`);
    return;
  }
  const project = parsed.value;
  // Locate the bin (spec §3: stored beside the project, never embedded).
  let binPath: string | null = joinPath(dirname(projPath), project.bin.name);
  let siblingExists: boolean;
  try {
    siblingExists = await host.exists(binPath);
  } catch (e) {
    actions.pushToast('error', `Cannot check for ${basename(binPath)}: ${errText(e)}`);
    return;
  }
  if (!siblingExists) {
    binPath = await host.openFile(`Locate ${project.bin.name}`, BIN_FILTERS);
    if (binPath === null) {
      actions.pushToast('info', 'Project open canceled');
      return;
    }
  }
  let image: BinImage;
  try {
    const bytes = await host.readBinary(binPath);
    image = createBinImage(bytes, basename(binPath));
  } catch (e) {
    actions.pushToast('error', `Cannot read ${basename(binPath)}: ${errText(e)}`);
    return;
  }
  if (image.sha256 !== project.bin.sha256) {
    // Spec §3/§8: explicit warning + explicit confirmation, never silent.
    const proceed = await host.confirm(
      `${image.name} does not match the bin recorded in the project (sha256 differs).\n` +
        `Map addresses may point at the wrong data. Load anyway?`,
      'Bin mismatch'
    );
    if (!proceed) {
      actions.pushToast('info', 'Project open canceled (sha mismatch)');
      return;
    }
  }
  const { droppedMaps, droppedPotentials, droppedAxisEntries, clearedStamps } = actions.applyProject(image, project);
  actions.setBinPath(binPath);
  actions.runChecksumVerify(); // applyProject cleared the old verdict — recompute for this bin
  // Provenance is read at exactly the moment it is being asked for
  // (2026-08-24-project-lineage-design.md §5).
  const from = project.derivedFrom === undefined ? '' : ` · derived from ${project.derivedFrom.name}`;
  const dropped = droppedMaps.length + droppedPotentials.length;
  if (dropped > 0) {
    actions.pushToast(
      'error',
      `Project loaded, but ${dropped} map(s) were out of range for ${image.name} and dropped (sha mismatch?). First: ${(droppedMaps[0] ?? droppedPotentials[0]) ?? ''}${from}`
    );
  } else {
    actions.pushToast(
      'info',
      `Project loaded: ${project.maps.length} maps, ${project.potentialMaps.length} potential — rescan to restore region dimming${from}`
    );
  }
  if (droppedAxisEntries.length > 0) {
    actions.pushToast(
      'error',
      `${droppedAxisEntries.length} axis library entr${droppedAxisEntries.length === 1 ? 'y was' : 'ies were'} out of range for ${image.name} and dropped. First: ${droppedAxisEntries[0] ?? ''}`
    );
  }
  if (clearedStamps.length > 0) {
    actions.pushToast(
      'info',
      `${clearedStamps.length} axis stamp(s) pointed at missing library entries and were detached (inline axes kept)`
    );
  }
}

export type ExportKind = 'romraider' | 'xdf' | 'csv' | 'json';

const EXPORT_META: Record<ExportKind, { title: string; ext: string; filter: string }> = {
  romraider: { title: 'Export RomRaider definition', ext: 'xml', filter: 'RomRaider definition' },
  xdf: { title: 'Export TunerPro XDF', ext: 'xdf', filter: 'TunerPro XDF' },
  csv: { title: 'Export map list (CSV)', ext: 'csv', filter: 'CSV map list' },
  json: { title: 'Export map list (JSON)', ext: 'json', filter: 'JSON map list' },
};

export async function exportFlow(host: PlatformHost, kind: ExportKind): Promise<void> {
  const image = get(bin);
  if (!image) {
    actions.pushToast('error', 'Open a bin first');
    return;
  }
  const confirmed = get(maps);
  // Spec §6: RomRaider export is "confirmed maps → a valid def" and XDF is a
  // definition too — both are CURATED artifacts, so they take confirmed maps
  // only. CSV/JSON are a map LIST (their frozen header carries confidence +
  // provenance), so they export confirmed maps PLUS ranked potentials — that
  // is what populates the confidence column.
  const isList = kind === 'csv' || kind === 'json';
  let source = isList ? [...confirmed, ...get(potentialMaps)] : confirmed;
  if (kind === 'romraider' && get(addressFrame) === 'ms41full') {
    // Frame active: the store holds file offsets; a RomRaider def carries SAs.
    // Invert exactly (unframeDefMaps is frameDefMaps' inverse); maps outside
    // the mapped cal window (e.g. promoted from code regions) have no SA
    // representation — leave them out loudly, never write a garbage address.
    const un = unframeDefMaps(source);
    if (un.skipped.length > 0) {
      actions.pushToast(
        'error',
        `${un.skipped.length} map(s) have no cal storageaddress on a full read and were left out. First: ${un.skipped[0] ?? ''}`
      );
    }
    source = un.maps;
    if (source.length === 0) {
      actions.pushToast('error', 'No exportable maps — none fall inside the mapped cal window');
      return;
    }
  }
  if (source.length === 0) {
    actions.pushToast(
      'error',
      isList
        ? 'Nothing to export — scan the bin or define maps first'
        : 'No confirmed maps to export — promote potential maps (K / double-click) first'
    );
    return;
  }
  const stem = stemOf(image.name);
  const result =
    kind === 'romraider' ? exportRomRaiderXml(stem, source)
    : kind === 'xdf' ? exportXdf(stem, image.size, source)
    : kind === 'csv' ? exportMapListCsv(source)
    : exportMapListJson(source);
  if (!result.ok) {
    actions.pushToast('error', `Export failed: ${result.error}`);
    return;
  }
  const meta = EXPORT_META[kind];
  const path = await host.saveFile(meta.title, `${stem}.${meta.ext}`, [{ name: meta.filter, extensions: [meta.ext] }]);
  if (path === null) return;
  try {
    await host.writeText(path, result.value);
    actions.pushToast('info', `Exported ${source.length} maps to ${basename(path)}`);
  } catch (e) {
    actions.pushToast('error', `Export failed: ${errText(e)}`);
  }
}

const DEF_FILTERS: FileFilter[] = [{ name: 'RomRaider definition', extensions: ['xml'] }];

export interface PickedDef {
  xml: string;
  romIds: string[];
}

/** Step 1 of Import Def: pick + read the XML and enumerate its rom ids. */
export async function pickDefFlow(host: PlatformHost): Promise<PickedDef | null> {
  const path = await host.openFile('Import RomRaider definition', DEF_FILTERS);
  if (path === null) return null;
  try {
    const xml = await host.readText(path);
    return { xml, romIds: listRomIds(xml) };
  } catch (e) {
    actions.pushToast('error', `Cannot read definition: ${errText(e)}`);
    return null;
  }
}

/**
 * Step 2 (after the rom picker when multi-rom): import + frame + validate + land.
 * On a bin ≥ 0x18000 the user is asked ONCE whether the def's storageaddresses
 * should be mapped through the MS41 full-read frame fo(SA) = (0x10000+SA)^0x4000
 * (spec 2026-07-14-fullread-def-frame-design — supersedes the v1 "defs align
 * only with 24KB CAL dumps" note). 24KB CAL dumps import addresses as-is.
 * The prompt is asked ONCE per loaded bin (a decline sticks until a new bin
 * loads).
 */
export async function importDef(host: PlatformHost, xml: string, romId: string | undefined): Promise<void> {
  const result = romId === undefined ? importRomRaiderXml(xml) : importRomRaiderXml(xml, romId);
  if (!result.ok) {
    actions.pushToast('error', `Import failed: ${result.error}`);
    return;
  }
  const image = get(bin);
  let frame = get(addressFrame);
  if (image !== null && isMs41FullRead(image.size) && frame === 'none' && !get(framePromptAnswered)) {
    let yes = false;
    try {
      yes = await host.confirm(
        `${image.name} looks like a full firmware read (≥ 96 KB).\n` +
          `Map definition addresses through the MS41 flash-bus frame (fo)?\n` +
          `Choose No to import addresses as-is (correct for 24 KB CAL dumps).`,
        'MS41 full read detected'
      );
      framePromptAnswered.set(true); // answered (yes or no) — not re-asked until a new bin loads
    } catch (e) {
      actions.pushToast('error', `Confirm failed: ${errText(e)} — importing addresses as-is`);
    }
    if (yes) {
      frame = 'ms41full';
      addressFrame.set('ms41full');
    }
  }
  let toLand = result.value.maps;
  let frameSkipped: string[] = [];
  if (frame === 'ms41full') {
    const framed = frameDefMaps(toLand);
    toLand = framed.maps;
    frameSkipped = framed.skipped;
  }
  const { added, skipped } = actions.addImportedMaps(toLand);
  const allSkipped = [...frameSkipped, ...skipped];
  const warnings = result.value.warnings.length;
  if (allSkipped.length > 0) {
    actions.pushToast(
      'error',
      `Imported ${added} maps, skipped ${allSkipped.length} (out of range / seam / duplicates). First: ${allSkipped[0] ?? ''}`
    );
  } else {
    actions.pushToast(
      'info',
      `Imported ${added} maps from rom ${result.value.romId}` +
        `${warnings > 0 ? ` (${warnings} importer warnings)` : ''}` +
        `${frame === 'ms41full' ? ' — addresses mapped via the MS41 full-read frame' : ''}`
    );
  }
}

/**
 * Export the tables this session edited (spec §6). The default selection is
 * COMPUTED — every confirmed map whose byte span the journal touched — so the
 * common case needs no typing.
 */
export async function exportPackFlow(host: PlatformHost): Promise<boolean> {
  const image = get(bin);
  if (image === null) {
    actions.pushToast('error', 'Open a bin first.');
    return false;
  }
  const identity = identifyBin(image.bytes);
  if (identity === undefined) {
    actions.pushToast(
      'error',
      "This bin's calibration id could not be read, so a pack could not be labelled for it."
    );
    return false;
  }
  const tables = actions.editedPackTables();
  if (tables.length === 0) {
    actions.pushToast('info', 'No edited tables to export — change some values first.');
    return false;
  }
  const pack: MapPack = {
    schemaVersion: 1,
    source: {
      familyId: identity.familyId,
      calId: identity.calId,
      binSha256: image.sha256,
      // The frame is decided by THIS IMAGE's size, not by the def-import
      // store: a map's address is a file offset in the loaded bin, so a full
      // read's offsets are ms41full whether or not a definition was ever
      // imported. Keying on the store labelled such a pack frameless, and it
      // then failed to classify against its own image.
      ...(isMs41FullRead(image.size) ? { addressFrame: 'ms41full' as const } : {}),
    },
    title: `${stemOf(image.name)} pack`,
    tables,
  };
  const path = await host.saveFile('Export map pack', `${stemOf(image.name)}.binpack.json`, PACK_FILTERS);
  if (path === null) return false;
  try {
    await host.writeText(path, serializePack(pack));
    actions.pushToast('info', `Exported ${tables.length} table(s) to ${basename(path)}`);
    return true;
  } catch (e) {
    actions.pushToast('error', `Export failed: ${errText(e)}`);
    return false;
  }
}

/**
 * Open a pack and queue it for review. The CAL-ID gate (spec §4.1) runs BEFORE
 * anything is queued: a mismatch is refused whole, with both ids named.
 */
export async function openPackFlow(host: PlatformHost): Promise<void> {
  const image = get(bin);
  const working = get(workingBytes);
  if (image === null || working === null) {
    actions.pushToast('error', 'Open a bin first.');
    return;
  }
  const path = await host.openFile('Open map pack', PACK_FILTERS);
  if (path === null) return;

  let text: string;
  try {
    text = await host.readText(path);
  } catch (e) {
    actions.pushToast('error', `Could not read the pack: ${errText(e)}`);
    return;
  }
  const parsed = parsePack(text);
  if (!parsed.ok) {
    actions.pushToast('error', `That is not a valid map pack: ${parsed.error}`);
    return;
  }
  const gate = packGateError(parsed.value, identifyBin(image.bytes));
  if (gate !== undefined) {
    actions.pushToast('error', gate);
    return;
  }
  const rows = classifyPack({
    pack: parsed.value,
    bytes: working,
    binIsFullRead: isMs41FullRead(image.size),
  });
  pendingPack.set({ pack: parsed.value, rows, fileName: basename(path) });
}
