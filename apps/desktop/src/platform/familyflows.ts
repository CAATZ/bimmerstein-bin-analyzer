import { get } from 'svelte/store';
import { clearExternalFamilies, registerExternalFamily, FAMILY_CHECKSUMS } from '@binanalyzer/families';
import * as actions from '../store/actions.js';
import { configuredFamilyPaths, loadedFamilies, type LoadedFamily } from '../store/families.js';
import { guarded, loadFamilyModule } from '../lib/familyloader.js';
import { basename, joinPath, type FileFilter, type PlatformHost } from './host.js';

/**
 * Drop-in family modules (2026-08-23-drop-in-family-modules-design.md).
 *
 * The app reads the file and evaluates it; `packages/families` only ever
 * receives a plain object, which is what keeps that package pure.
 */
const MODULE_FILTERS: FileFilter[] = [{ name: 'Family module', extensions: ['js'] }];

/**
 * Where a dropped-in module goes. Under the app's own data dir, which
 * `fs:default` already grants. Joined with the platform's OWN separator: this
 * string is displayed to the user as the folder to drop files into, and a
 * mixed-separator path reads like a bug.
 */
export const familiesFolder = (appLocalData: string): string => joinPath(appLocalData, 'families');

async function loadOne(host: PlatformHost, path: string, out: LoadedFamily[]): Promise<void> {
  let src: string;
  try {
    src = await host.readText(path);
  } catch (e) {
    actions.pushToast('error', `Could not read ${basename(path)}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const r = loadFamilyModule(src);
  if (!r.ok) {
    actions.pushToast('error', `${basename(path)}: ${r.error}`);
    return;
  }
  registerExternalFamily(guarded(r.value, (m) => actions.pushToast('error', m)));
  out.push({ familyId: r.value.familyId, path });
}

/**
 * Re-read everything: the folder, then the configured paths. Replaces the
 * loaded set rather than adding to it, so this doubles as the dialog's Reload.
 */
export async function reloadFamilies(host: PlatformHost, appLocalData: string): Promise<void> {
  clearExternalFamilies();
  const out: LoadedFamily[] = [];

  const folder = familiesFolder(appLocalData);
  await host.mkdirp(folder);
  for (const path of (await host.readDir(folder)).filter((p) => p.toLowerCase().endsWith('.js'))) {
    await loadOne(host, path, out);
  }
  for (const path of get(configuredFamilyPaths)) {
    await loadOne(host, path, out);
  }
  loadedFamilies.set(out);
  actions.runChecksumVerify();
}

/** Pick a module, remember it, and load it. */
export async function addFamilyModule(host: PlatformHost, appLocalData: string): Promise<void> {
  const path = await host.openFile('Add family module', MODULE_FILTERS);
  if (path === null) return;
  const current = get(configuredFamilyPaths);
  if (!current.includes(path)) configuredFamilyPaths.set([...current, path]);
  await reloadFamilies(host, appLocalData);
}

/** Forget a configured module and unload it. */
export async function removeFamilyModule(
  host: PlatformHost,
  appLocalData: string,
  path: string
): Promise<void> {
  configuredFamilyPaths.set(get(configuredFamilyPaths).filter((p) => p !== path));
  await reloadFamilies(host, appLocalData);
}

/** Built-ins, for the dialog to list beside the drop-ins. */
export const builtInFamilies = (): LoadedFamily[] =>
  FAMILY_CHECKSUMS.map((c) => ({ familyId: c.familyId, path: '(built-in)' }));
