import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { applyProposal } from '../src/copilot/dispatch.js';
import { undo } from '../src/store/undo.js';
import { maps, proposals } from '../src/store/stores.js';

function mapAt(id: string, address: number): MapDef {
  return {
    id, name: `M ${id}`, address, rows: 2, cols: 4,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major', provenance: 'imported',
  };
}

beforeEach(() => {
  a.resetStores();
  a.setBin(createBinImage(Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff), 'live.bin'));
  a.addImportedMaps([mapAt('m1', 0x100), mapAt('m2', 0x200)]);
  proposals.set([{
    requestId: 'r1',
    title: 'Name the ignition tables',
    changes: [
      { id: 'c1', mapId: 'm1', name: 'Dwell' },
      { id: 'c2', mapId: 'm2', name: 'Spark' },
      { id: 'c3', mapId: 'ghost', name: 'Nope' },
    ],
  }]);
});

describe('applyProposal', () => {
  it('applies only the accepted rows', () => {
    const r = applyProposal('r1', ['c1']);
    expect(r.accepted).toEqual(['c1']);
    expect(r.rejected).toEqual(['c2', 'c3']);
    expect(get(maps).find((m) => m.id === 'm1')!.name).toBe('Dwell');
    expect(get(maps).find((m) => m.id === 'm2')!.name).toBe('M m2');
  });

  it('reports a row the app refuses without failing the batch', () => {
    const r = applyProposal('r1', ['c1', 'c3']);
    expect(r.accepted).toEqual(['c1']);
    expect(r.failed).toEqual([{ id: 'c3', error: 'no confirmed map with id ghost' }]);
  });

  it('is ONE undo step for the whole batch', () => {
    applyProposal('r1', ['c1', 'c2']);
    expect(get(maps).map((m) => m.name)).toEqual(['Dwell', 'Spark']);
    expect(undo()).toBe(true);
    expect(get(maps).map((m) => m.name)).toEqual(['M m1', 'M m2']);
  });

  it('removes the proposal from the queue either way', () => {
    applyProposal('r1', []);
    expect(get(proposals)).toEqual([]);
  });

  it('an unknown requestId is a no-op, not a throw', () => {
    expect(applyProposal('r999', ['c1'])).toEqual({ accepted: [], rejected: [], failed: [] });
  });

  it('applies an addMap row from a definition import', () => {
    proposals.set([{
      requestId: 'r2',
      title: 'Import 1 map',
      changes: [{ id: 'i0', addMap: mapAt('imported-1', 0x300) }],
    }]);
    const r = applyProposal('r2', ['i0']);
    expect(r.accepted).toEqual(['i0']);
    expect(get(maps).some((m) => m.id === 'imported-1')).toBe(true);
  });
});
