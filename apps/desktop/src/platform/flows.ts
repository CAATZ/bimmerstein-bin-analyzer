import { get } from 'svelte/store';
import { createBinImage } from '@binanalyzer/core';
import type { BinImage } from '@binanalyzer/core';
import {
  exportMapListCsv, exportMapListJson, exportRomRaiderXml, exportXdf, importRomRaiderXml, parseProject, serializeProject,
} from '@binanalyzer/formats';
import * as actions from '../store/actions.js';
import { listRomIds } from '../lib/romlist.js';
import { addressFrame, bin, framePromptAnswered, maps, potentialMaps } from '../store/stores.js';
import { frameDefMaps, isMs41FullRead, unframeDefMaps } from '@binanalyzer/appkit';
import { basename, dirname, joinPath, stemOf, type FileFilter, type PlatformHost } from './host.js';

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

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function openBinFlow(host: PlatformHost): Promise<boolean> {
  const path = await host.openFile('Open ECU bin', BIN_FILTERS);
  if (path === null) return false;
  return loadBinFromPath(host, path);
}

export async function loadBinFromPath(host: PlatformHost, path: string): Promise<boolean> {
  try {
    const bytes = await host.readBinary(path);
    if (bytes.length === 0) {
      actions.pushToast('error', `${basename(path)} is empty`);
      return false;
    }
    actions.setBin(createBinImage(bytes, basename(path)));
    actions.setBinPath(path); // AFTER setBin — setBin clears it
    actions.runChecksumVerify(bytes); // raw bytes still in hand here
    return true;
  } catch (e) {
    actions.pushToast('error', `Cannot read ${basename(path)}: ${errText(e)}`);
    return false;
  }
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
    return true;
  } catch (e) {
    actions.pushToast('error', `Save failed: ${errText(e)}`);
    return false;
  }
}

export async function openProjectFlow(host: PlatformHost): Promise<void> {
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
  const dropped = droppedMaps.length + droppedPotentials.length;
  if (dropped > 0) {
    actions.pushToast(
      'error',
      `Project loaded, but ${dropped} map(s) were out of range for ${image.name} and dropped (sha mismatch?). First: ${(droppedMaps[0] ?? droppedPotentials[0]) ?? ''}`
    );
  } else {
    actions.pushToast(
      'info',
      `Project loaded: ${project.maps.length} maps, ${project.potentialMaps.length} potential — rescan to restore region dimming`
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
