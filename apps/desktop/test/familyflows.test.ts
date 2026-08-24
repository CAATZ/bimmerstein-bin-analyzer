import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { checksumsFor, clearExternalFamilies } from '@binanalyzer/families';
import * as a from '../src/store/actions.js';
import { toasts } from '../src/store/stores.js';
import { configuredFamilyPaths, loadedFamilies } from '../src/store/families.js';
import {
  addFamilyModule,
  familiesFolder,
  reloadFamilies,
  removeFamilyModule,
} from '../src/platform/familyflows.js';
import { FakeHost } from './flows.test.js';

const APPDATA = '/appdata';
const MOD = (id: string): string =>
  `return { familyId: '${id}', applies: (b) => b.length === 16, identify: () => undefined,` +
  ` verify: () => ({ familyId: '${id}', applies: true, blocks: [], valid: false, skipped: [], notes: [] }),` +
  ` correct: (b) => ({ bytes: b, report: { familyId: '${id}', applies: true, blocks: [], valid: false, skipped: [], notes: [] }, changed: [] }) };`;

const lastToast = (): string => get(toasts).at(-1)?.text ?? '';

describe('reloadFamilies', () => {
  beforeEach(() => {
    a.resetStores();
    clearExternalFamilies();
    configuredFamilyPaths.set([]);
  });

  it('loads every .js in the families folder', async () => {
    const h = new FakeHost();
    h.files.set(`${familiesFolder(APPDATA)}/ms42.js`, MOD('ms42'));
    await reloadFamilies(h, APPDATA);
    expect(get(loadedFamilies).map((f) => f.familyId)).toContain('ms42');
    expect(checksumsFor(new Uint8Array(16))?.familyId).toBe('ms42');
  });

  it('ignores files that are not .js', async () => {
    const h = new FakeHost();
    h.files.set(`${familiesFolder(APPDATA)}/notes.txt`, 'hello');
    await reloadFamilies(h, APPDATA);
    expect(get(loadedFamilies)).toEqual([]);
  });

  it('reports a broken module by NAME and still loads the others', async () => {
    const h = new FakeHost();
    h.files.set(`${familiesFolder(APPDATA)}/broken.js`, 'return {');
    h.files.set(`${familiesFolder(APPDATA)}/ms42.js`, MOD('ms42'));
    await reloadFamilies(h, APPDATA);
    expect(get(loadedFamilies).map((f) => f.familyId)).toEqual(['ms42']);
    expect(get(toasts).map((t) => t.text).join(' ')).toContain('broken.js');
  });

  it('loads configured paths as well as the folder', async () => {
    const h = new FakeHost();
    h.files.set('/elsewhere/ms43.js', MOD('ms43'));
    configuredFamilyPaths.set(['/elsewhere/ms43.js']);
    await reloadFamilies(h, APPDATA);
    expect(get(loadedFamilies).map((f) => f.familyId)).toContain('ms43');
  });

  it('replaces the previous set rather than accumulating', async () => {
    const h = new FakeHost();
    h.files.set(`${familiesFolder(APPDATA)}/ms42.js`, MOD('ms42'));
    await reloadFamilies(h, APPDATA);
    await reloadFamilies(h, APPDATA);
    expect(get(loadedFamilies)).toHaveLength(1);
  });

  it('records where each module came from', async () => {
    const h = new FakeHost();
    h.files.set(`${familiesFolder(APPDATA)}/ms42.js`, MOD('ms42'));
    await reloadFamilies(h, APPDATA);
    expect(get(loadedFamilies)[0]!.path).toBe(`${familiesFolder(APPDATA)}/ms42.js`);
  });
});

describe('addFamilyModule / removeFamilyModule', () => {
  beforeEach(() => {
    a.resetStores();
    clearExternalFamilies();
    configuredFamilyPaths.set([]);
  });

  it('adds a picked file, persists the path, and loads it', async () => {
    const h = new FakeHost();
    h.openAnswers = ['/picked/ms44.js'];
    h.files.set('/picked/ms44.js', MOD('ms44'));
    await addFamilyModule(h, APPDATA);
    expect(get(configuredFamilyPaths)).toEqual(['/picked/ms44.js']);
    expect(get(loadedFamilies).map((f) => f.familyId)).toContain('ms44');
  });

  it('does nothing when the picker is cancelled', async () => {
    await addFamilyModule(new FakeHost(), APPDATA);
    expect(get(configuredFamilyPaths)).toEqual([]);
  });

  it('does not add the same path twice', async () => {
    const h = new FakeHost();
    h.files.set('/picked/ms44.js', MOD('ms44'));
    h.openAnswers = ['/picked/ms44.js', '/picked/ms44.js'];
    await addFamilyModule(h, APPDATA);
    await addFamilyModule(h, APPDATA);
    expect(get(configuredFamilyPaths)).toEqual(['/picked/ms44.js']);
  });

  it('removes a configured path and unloads it', async () => {
    const h = new FakeHost();
    h.openAnswers = ['/picked/ms44.js'];
    h.files.set('/picked/ms44.js', MOD('ms44'));
    await addFamilyModule(h, APPDATA);
    await removeFamilyModule(h, APPDATA, '/picked/ms44.js');
    expect(get(configuredFamilyPaths)).toEqual([]);
    expect(get(loadedFamilies)).toEqual([]);
  });
});

describe('familiesFolder', () => {
  it('uses the separator the parent path already uses', () => {
    // The string is shown to the user as "drop files here"; a Windows path
    // with a stray forward slash in it reads like a bug.
    //
    // Deliberately NOT under a home directory: the pre-push scrub greps for
    // personal absolute paths, and a synthetic one that trips it trains the
    // reader to ignore a check that has caught real leaks twice.
    expect(familiesFolder('D:\\apps\\binalyzer')).toBe('D:\\apps\\binalyzer\\families');
    expect(familiesFolder('/opt/binalyzer')).toBe('/opt/binalyzer/families');
  });
});
