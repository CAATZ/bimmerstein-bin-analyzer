import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { createBinImage, sha256Hex } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import {
  NO_BIN_OPEN, SINGLE_CHANGE_BURST, applyProposal, dispatchOp, resetBurstWindow,
} from '../src/copilot/dispatch.js';
import { axisLibrary, bin, maps, potentialMaps, proposals, selection, toasts, viewParams, workingBytes } from '../src/store/stores.js';

function testBin() {
  return createBinImage(Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff), 'live.bin');
}

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
  a.setBin(testBin());
  resetBurstWindow();
});

describe('Point ops', () => {
  it('select sets a byte range and reports what was applied', async () => {
    const r = await dispatchOp('select', { address: 0x100, length: 32, cols: 8 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value['applied']).toMatchObject({ start: 0x100, end: 0x120, cols: 8 });
    expect(get(selection)).toMatchObject({ start: 0x100, end: 0x120 });
  });

  it('select by mapId selects that map', async () => {
    a.addImportedMaps([mapAt('m1', 0x100)]);
    expect((await dispatchOp('select', { mapId: 'm1' })).ok).toBe(true);
    expect(get(selection)?.mapId).toBe('m1');
  });

  it('select by an unknown mapId is a clean error, not a throw', async () => {
    const r = await dispatchOp('select', { mapId: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('nope');
  });

  it('show moves the view without touching data', async () => {
    a.addImportedMaps([mapAt('m1', 0x100)]);
    const before = get(maps);
    await dispatchOp('show', { address: 0x40, viewMode: '2d' });
    expect(get(viewParams).viewMode).toBe('2d');
    expect(get(maps)).toBe(before);
  });

  it('show rejects an unknown view mode', async () => {
    const r = await dispatchOp('show', { viewMode: 'wireframe' });
    expect(r.ok).toBe(false);
  });

  it('open_map selects and switches view', async () => {
    a.addImportedMaps([mapAt('m1', 0x100)]);
    expect((await dispatchOp('open_map', { mapId: 'm1' })).ok).toBe(true);
    expect(get(selection)?.mapId).toBe('m1');
    expect(get(viewParams).viewMode).toBe('3d');
  });
});

describe('single Change ops', () => {
  it('change_map renames through updateMapMeta', async () => {
    a.addImportedMaps([mapAt('m1', 0x100)]);
    expect((await dispatchOp('change_map', { mapId: 'm1', name: 'Dwell' })).ok).toBe(true);
    expect(get(maps)[0]!.name).toBe('Dwell');
  });

  it("returns the app's own validation message verbatim", async () => {
    const r = await dispatchOp('change_map', { mapId: 'ghost', name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no confirmed map with id ghost');
  });

  it('change_map remove works', async () => {
    a.addImportedMaps([mapAt('m1', 0x100)]);
    expect((await dispatchOp('change_map', { mapId: 'm1', remove: true })).ok).toBe(true);
    expect(get(maps)).toHaveLength(0);
  });

  it('change_axis_entry creates and removes an entry', async () => {
    const created = await dispatchOp('change_axis_entry', {
      create: {
        name: 'RPM',
        axis: { kind: 'referenced', address: 0x800, count: 4, format: { width: 1, signed: false, endianness: 'little' } },
      },
    });
    expect(created.ok).toBe(true);
    const id = get(axisLibrary)[0]!.id;
    expect((await dispatchOp('change_axis_entry', { entryId: id, remove: true })).ok).toBe(true);
    expect(get(axisLibrary)).toHaveLength(0);
  });
});

describe('single Changes are toasted (spec §7.1)', () => {
  it('a rename toasts, naming the map the co-pilot touched', async () => {
    a.addImportedMaps([mapAt('m1', 0x100)]);
    await dispatchOp('change_map', { mapId: 'm1', name: 'Dwell' });
    expect(get(toasts)).toHaveLength(1);
    expect(get(toasts)[0]!.text).toContain('Dwell');
    expect(get(toasts)[0]!.text.toLowerCase()).toContain('co-pilot');
  });

  it('a removal toasts too', async () => {
    a.addImportedMaps([mapAt('m1', 0x100)]);
    await dispatchOp('change_map', { mapId: 'm1', remove: true });
    expect(get(toasts)).toHaveLength(1);
    expect(get(toasts)[0]!.text).toContain('m1');
  });

  it('an axis-library change toasts', async () => {
    await dispatchOp('change_axis_entry', {
      create: {
        name: 'RPM',
        axis: { kind: 'referenced', address: 0x800, count: 4, format: { width: 1, signed: false, endianness: 'little' } },
      },
    });
    expect(get(toasts)).toHaveLength(1);
    expect(get(toasts)[0]!.text).toContain('RPM');
  });

  it('a rejected change says nothing — there is nothing to report', async () => {
    const r = await dispatchOp('change_map', { mapId: 'ghost', name: 'x' });
    expect(r.ok).toBe(false);
    expect(get(toasts)).toHaveLength(0);
  });

  it('an escalated change does not toast — the panel is the surface', async () => {
    a.addImportedMaps([mapAt('m1', 0x100)]);
    for (let i = 0; i < SINGLE_CHANGE_BURST; i++) await dispatchOp('change_map', { mapId: 'm1', name: `n${i}` });
    toasts.set([]);
    await dispatchOp('change_map', { mapId: 'm1', name: 'escalated' });
    expect(get(proposals)).toHaveLength(1);
    expect(get(toasts)).toHaveLength(0);
  });

  it('an accepted proposal does NOT toast per row — 306 toasts would bury the app', () => {
    const changes = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, addMap: mapAt(`p${i}`, 0x200 + i * 8) }));
    proposals.set([{ requestId: 'r1', title: 'Import 12 maps', changes }]);
    applyProposal('r1', changes.map((c) => c.id));
    expect(get(maps)).toHaveLength(12);
    expect(get(toasts).length).toBeLessThanOrEqual(1);
  });
});

describe('burst escalation (spec §7.1)', () => {
  it('converts the next single Change into a proposal after a burst', async () => {
    a.addImportedMaps([mapAt('m1', 0x100)]);
    for (let i = 0; i < SINGLE_CHANGE_BURST; i++) {
      const r = await dispatchOp('change_map', { mapId: 'm1', name: `n${i}` });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value['escalated']).toBeUndefined();
    }
    const next = await dispatchOp('change_map', { mapId: 'm1', name: 'n5' });
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.value['escalated']).toBe(true);
    expect(get(proposals)).toHaveLength(1);
    expect(get(maps)[0]!.name).toBe(`n${SINGLE_CHANGE_BURST - 1}`); // the escalated one did NOT apply
  });

  it('the window expires', async () => {
    vi.useFakeTimers();
    try {
      a.addImportedMaps([mapAt('m1', 0x100)]);
      for (let i = 0; i < SINGLE_CHANGE_BURST; i++) await dispatchOp('change_map', { mapId: 'm1', name: `n${i}` });
      vi.advanceTimersByTime(11_000);
      const after = await dispatchOp('change_map', { mapId: 'm1', name: 'later' });
      expect(after.ok).toBe(true);
      if (after.ok) expect(after.value['escalated']).toBeUndefined();
      expect(get(maps)[0]!.name).toBe('later');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('propose and getBinBytes', () => {
  it('propose queues a panel entry and changes nothing yet', async () => {
    a.addImportedMaps([mapAt('m1', 0x100)]);
    const r = await dispatchOp('propose', {
      requestId: 'r1', title: 'Rename', changes: [{ id: 'c1', mapId: 'm1', name: 'Dwell' }],
    });
    expect(r.ok).toBe(true);
    expect(get(proposals)[0]).toMatchObject({ requestId: 'r1', title: 'Rename' });
    expect(get(maps)[0]!.name).toBe('M m1');
  });

  it('propose refuses a malformed batch', async () => {
    expect((await dispatchOp('propose', { title: 'x', changes: [] })).ok).toBe(false);
    expect((await dispatchOp('propose', { requestId: 'r', changes: [{ id: 'c' }] })).ok).toBe(false);
  });

  it('getBinBytes returns the loaded bytes as base64', async () => {
    const r = await dispatchOp('getBinBytes', { sha256: testBin().sha256 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.value['base64']).toBe('string');
      expect(atob(String(r.value['base64'])).length).toBe(4096);
    }
  });

  it('getBinBytes refuses when the sha does not match what is loaded', async () => {
    const r = await dispatchOp('getBinBytes', { sha256: 'f'.repeat(64) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('different bin');
  });
});

describe('guards', () => {
  it('every data op errors with no bin loaded', async () => {
    a.resetStores();
    for (const op of ['select', 'show', 'open_map', 'change_map', 'getBinBytes']) {
      const r = await dispatchOp(op, { mapId: 'm', address: 0, name: 'x', sha256: 'a' });
      expect(r.ok, `${op} must guard`).toBe(false);
      if (!r.ok) expect(r.error).toContain('no bin');
    }
  });

  // Spec §5.4: the no-bin error must tell the agent to ASK THE USER, because
  // opening a bin is the user's action by design — open_bin is not in this
  // mode's tool set. GUI acceptance D8 checks exactly this sentence.
  it('the no-bin error names the recovery action the user has to take', async () => {
    a.resetStores();
    for (const op of ['select', 'show', 'open_map', 'change_map', 'getBinBytes']) {
      const r = await dispatchOp(op, { mapId: 'm', address: 0, name: 'x', sha256: 'a' });
      expect(r.ok, `${op} must guard`).toBe(false);
      if (!r.ok) expect(r.error, `${op} message`).toBe(NO_BIN_OPEN);
    }
  });

  it('an unknown op is reported, not thrown', async () => {
    const r = await dispatchOp('delete_everything', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('delete_everything');
  });
});

describe('getBinBytes names the buffer it sent', () => {
  const editMap = (): MapDef => ({
    id: 'm1', name: 'M', address: 0x10, rows: 2, cols: 2,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 0.1, offset: 0, units: '', digits: 1 },
    orientation: 'row-major', provenance: 'manual',
  });

  beforeEach(() => {
    a.resetStores();
    a.setBin(testBin());
    expect(a.editCell(editMap(), 0, 0, 20).ok).toBe(true);
  });

  it('defaults to working and hashes WHAT IT SENT', async () => {
    const r = await dispatchOp('getBinBytes', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value['which']).toBe('working');
    expect(r.value['sha256']).toBe(sha256Hex(get(workingBytes)!));
    expect(r.value['sha256']).not.toBe(get(bin)!.sha256);
  });

  it('serves the original on request, under the ORIGINAL hash', async () => {
    const r = await dispatchOp('getBinBytes', { which: 'original' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value['which']).toBe('original');
    expect(r.value['sha256']).toBe(get(bin)!.sha256);
  });

  it('still refuses when the app holds a different bin', async () => {
    const r = await dispatchOp('getBinBytes', { sha256: 'not-this-bin' });
    expect(r.ok).toBe(false);
  });
});
