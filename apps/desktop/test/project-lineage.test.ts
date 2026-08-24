import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBinImage, type Project } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { loadedLineage } from '../src/store/stores.js';

const STOCK = createBinImage(Uint8Array.from({ length: 64 }, (_, i) => i), 'stock.bin');
const TUNE = createBinImage(Uint8Array.from({ length: 64 }, (_, i) => i ^ 0xff), 'stage2.bin');

const snapshot = (): Project => {
  const r = a.projectSnapshot();
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const projectWithLineage = (): Project => ({
  ...snapshot(),
  derivedFrom: { name: 'ancestor.bin', sha256: 'c'.repeat(64) },
});

describe('projectSnapshot lineage', () => {
  beforeEach(() => {
    a.resetStores();
    a.setBin(STOCK);
  });

  it('records NOTHING when the session never saved a bin', () => {
    expect(snapshot().derivedFrom).toBeUndefined();
  });

  it('records the OPENED image once a save target with a different sha exists', () => {
    a.setSaveTarget({ path: '/x/stage2.bin', name: TUNE.name, sha256: TUNE.sha256, size: TUNE.size });
    expect(snapshot().derivedFrom).toEqual({ name: 'stock.bin', sha256: STOCK.sha256 });
  });

  it('records NOTHING when the save target has the SAME sha — a file is not its own ancestor', () => {
    a.setSaveTarget({ path: '/x/stock.bin', name: STOCK.name, sha256: STOCK.sha256, size: STOCK.size });
    expect(snapshot().derivedFrom).toBeUndefined();
  });

  it('CARRIES the loaded lineage when this session saved no new bin', () => {
    // The common workflow: open a project, add a map, save the project. Losing
    // the provenance here would make the whole feature useless.
    a.applyProject(STOCK, projectWithLineage());
    expect(snapshot().derivedFrom).toEqual({ name: 'ancestor.bin', sha256: 'c'.repeat(64) });
  });

  it('REPLACES the loaded lineage with a measurement once a new bin is saved', () => {
    a.applyProject(STOCK, projectWithLineage());
    a.setSaveTarget({ path: '/x/stage3.bin', name: TUNE.name, sha256: TUNE.sha256, size: TUNE.size });
    expect(snapshot().derivedFrom).toEqual({ name: 'stock.bin', sha256: STOCK.sha256 });
  });
});

describe('loadedLineage is per-bin state', () => {
  beforeEach(() => {
    a.resetStores();
    a.setBin(STOCK);
  });

  it('is cleared by setBin, so a new image cannot inherit an old ancestry', () => {
    a.applyProject(STOCK, projectWithLineage());
    expect(get(loadedLineage)).not.toBeNull();
    a.setBin(TUNE);
    expect(get(loadedLineage)).toBeNull();
    expect(snapshot().derivedFrom).toBeUndefined();
  });

  it('is cleared by resetStores', () => {
    a.applyProject(STOCK, projectWithLineage());
    a.resetStores();
    expect(get(loadedLineage)).toBeNull();
  });
});
