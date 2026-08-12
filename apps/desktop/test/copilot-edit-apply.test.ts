import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AxisDef, MapDef } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import { DISPATCH_OPS, applyProposal, dispatchOp, kindOfForTest } from '../src/copilot/dispatch.js';
import * as a from '../src/store/actions.js';
import { checksumReport, editJournal, proposals, workingBytes } from '../src/store/stores.js';
import { clearUndo, undo } from '../src/store/undo.js';
import { ms41TuneImage } from './ms41-image.js';

const u8 = { width: 1, signed: false, endianness: 'little' } as const;
const ident = { factor: 1, offset: 0, units: '', digits: 0 };

/**
 * Breakpoints at 0x30. validateMapDef requires xAxis.count === cols, so every
 * axis case below uses a 1x4 map rather than the default 2x2.
 */
const refAxis: AxisDef = { kind: 'referenced', address: 0x30, count: 4, format: u8, scaling: ident };
const AXIS_SHAPE = { rows: 1, cols: 4 } as const;

const map = (over: Partial<MapDef> = {}): MapDef => ({
  id: 'm1', name: 'M', address: 0x10, rows: 2, cols: 2, format: u8,
  scaling: ident, orientation: 'row-major', provenance: 'manual', ...over,
});

/** Flat 64-byte image, every byte 100, with the map registered as confirmed. */
const seed = (over: Partial<MapDef> = {}): MapDef => {
  a.resetStores();
  a.setBin(createBinImage(new Uint8Array(64).fill(100), 'e.bin'));
  const m = map(over);
  expect(a.addImportedMaps([m]).added).toBe(1);
  // addImportedMaps pushes its own undo entry; clear it so the batch tests
  // below measure ONLY the proposal's step.
  clearUndo();
  return m;
};

const rawAt = (offset: number): number => get(workingBytes)![offset]!;

describe('edit rows are routed on kind, not on shape', () => {
  it('a cell row is never inferred as a change_map', () => {
    // THE hazard (Part C §4.4): a cell row has a mapId and none of the other
    // discriminators, so shape inference falls through to 'change_map', which
    // builds an empty patch, applies NOTHING and returns ok — a dropped byte
    // edit reported as applied. Asserted on ROUTING because the wrong path's
    // return value is indistinguishable from success.
    expect(kindOfForTest({ id: 'e1', kind: 'cell', mapId: 'm1', row: 0, col: 0, value: 1, expectedRaw: 2 }))
      .toBe('map_edit');
    expect(kindOfForTest({ id: 'a1', kind: 'axis', mapId: 'm1', axis: 'x', index: 0, value: 1, expectedRaw: 2 }))
      .toBe('map_edit');
  });

  it('still routes the metadata shapes it always did', () => {
    expect(kindOfForTest({ id: 'c1', mapId: 'm1', name: 'Fuel' })).toBe('change_map');
    expect(kindOfForTest({ id: 'c2', entryId: 'x1', name: 'RPM' })).toBe('change_axis_entry');
    expect(kindOfForTest({ id: 'c3', addMap: {} })).toBe('addMap');
    expect(kindOfForTest({ id: 'c4', op: 'change_map', mapId: 'm1' })).toBe('change_map');
  });
});

describe('the dispatcher op set is frozen', () => {
  it('is exactly the allowlist — no save op may be added without this failing', () => {
    expect([...DISPATCH_OPS].sort()).toEqual([
      'change_axis_entry', 'change_map', 'getBinBytes', 'open_map',
      'propose', 'save_project', 'select', 'show',
    ]);
  });

  it('refuses anything that would write a bin', async () => {
    for (const op of ['save_bin', 'save_bin_as', 'write_bin', 'saveBinFlow']) {
      const r = await dispatchOp(op, {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('unknown co-pilot op');
    }
  });
});

describe('applyProposedEdit', () => {
  it('writes the byte when expectedRaw matches', () => {
    const m = seed();
    const r = a.applyProposedEdit({
      id: 'e1', kind: 'cell', mapId: m.id, row: 0, col: 0, value: 101, raw: true, expectedRaw: 100,
    });
    expect(r.ok).toBe(true);
    expect(rawAt(0x10)).toBe(101);
    expect(get(editJournal).get(0x10)).toEqual({ original: 100, current: 101 });
  });

  it('refuses when the byte moved, and names BOTH numbers', () => {
    const m = seed();
    const r = a.applyProposedEdit({
      id: 'e1', kind: 'cell', mapId: m.id, row: 0, col: 0, value: 1, raw: true, expectedRaw: 107,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('107');
      expect(r.error).toContain('100');
    }
    expect(rawAt(0x10)).toBe(100);
    expect(get(editJournal).size).toBe(0);
  });

  it('refuses a cell outside the map', () => {
    const m = seed();
    const r = a.applyProposedEdit({
      id: 'e1', kind: 'cell', mapId: m.id, row: 2, col: 0, value: 1, raw: true, expectedRaw: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('outside');
  });

  it('refuses an unknown map', () => {
    seed();
    const r = a.applyProposedEdit({
      id: 'e1', kind: 'cell', mapId: 'nope', row: 0, col: 0, value: 1, raw: true, expectedRaw: 100,
    });
    expect(r.ok).toBe(false);
  });

  it('writes a referenced axis breakpoint through the AXIS format', () => {
    const m = seed({ ...AXIS_SHAPE, xAxis: refAxis });
    const r = a.applyProposedEdit({
      id: 'a1', kind: 'axis', mapId: m.id, axis: 'x', index: 2, value: 120, raw: true, expectedRaw: 100,
    });
    expect(r.ok).toBe(true);
    expect(rawAt(0x30 + 2)).toBe(120);
  });

  it('refuses an index axis, with the reason', () => {
    const m = seed({ ...AXIS_SHAPE, xAxis: { kind: 'index', count: 4 } });
    const r = a.applyProposedEdit({
      id: 'a1', kind: 'axis', mapId: m.id, axis: 'x', index: 0, value: 1, raw: true, expectedRaw: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('index axis');
  });

  it('clamps rather than wraps', () => {
    const m = seed();
    const r = a.applyProposedEdit({
      id: 'e1', kind: 'cell', mapId: m.id, row: 0, col: 0, value: 999, raw: true, expectedRaw: 100,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.clamped).toBe(true);
    expect(rawAt(0x10)).toBe(255);
  });
});

describe('accepting a batch', () => {
  it('is ONE undo step that reverts the BUFFER, not just the journal', () => {
    const m = seed();
    proposals.set([{
      requestId: 'r1',
      title: 'two cells',
      changes: [
        { id: 'e1', kind: 'cell', mapId: m.id, row: 0, col: 0, value: 101, raw: true, expectedRaw: 100 },
        { id: 'e2', kind: 'cell', mapId: m.id, row: 0, col: 1, value: 102, raw: true, expectedRaw: 100 },
      ],
    }]);

    const outcome = applyProposal('r1', ['e1', 'e2']);
    expect(outcome.accepted).toEqual(['e1', 'e2']);
    expect(rawAt(0x10)).toBe(101);
    expect(rawAt(0x11)).toBe(102);

    // The BUFFER, not merely the journal — a reference-holding snapshot passes
    // the journal-only assertion (B1's lesson).
    expect(undo()).toBe(true);
    expect(rawAt(0x10)).toBe(100);
    expect(rawAt(0x11)).toBe(100);
    expect(get(editJournal).size).toBe(0);
    expect(undo()).toBe(false);   // exactly ONE entry, not two
  });

  it('applies only the checked rows', () => {
    const m = seed();
    proposals.set([{
      requestId: 'r1', title: 'partial',
      changes: [
        { id: 'e1', kind: 'cell', mapId: m.id, row: 0, col: 0, value: 101, raw: true, expectedRaw: 100 },
        { id: 'e2', kind: 'cell', mapId: m.id, row: 0, col: 1, value: 102, raw: true, expectedRaw: 100 },
      ],
    }]);
    const outcome = applyProposal('r1', ['e1']);
    expect(outcome.accepted).toEqual(['e1']);
    expect(outcome.rejected).toEqual(['e2']);
    expect(rawAt(0x11)).toBe(100);
  });

  it('a stale row fails ALONE and is reported', () => {
    const m = seed();
    proposals.set([{
      requestId: 'r1', title: 'one stale',
      changes: [
        { id: 'e1', kind: 'cell', mapId: m.id, row: 0, col: 0, value: 101, raw: true, expectedRaw: 100 },
        { id: 'e2', kind: 'cell', mapId: m.id, row: 0, col: 1, value: 102, raw: true, expectedRaw: 55 },
      ],
    }]);
    const outcome = applyProposal('r1', ['e1', 'e2']);
    expect(outcome.accepted).toEqual(['e1']);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.id).toBe('e2');
    expect(outcome.failed[0]!.error).toContain('55');
    expect(rawAt(0x10)).toBe(101);   // the good row still landed
  });

  it('re-verifies checksums once the batch has landed', () => {
    // Needs an image the MS41 module actually recognises, so a report exists.
    a.resetStores();
    a.setBin(createBinImage(ms41TuneImage(), 'tune.bin'));
    a.runChecksumVerify(); // the load-time verdict, as flows.ts does
    const m = map({ address: 0x1200 });
    expect(a.addImportedMaps([m]).added).toBe(1);
    const before = get(checksumReport);
    expect(before).toBeDefined();

    const was = rawAt(0x1200);
    proposals.set([{
      requestId: 'r1', title: 'one',
      changes: [{ id: 'e1', kind: 'cell', mapId: m.id, row: 0, col: 0, value: was ^ 0xff, raw: true, expectedRaw: was }],
    }]);
    applyProposal('r1', ['e1']);
    expect(get(checksumReport)).not.toBe(before);
  });
});

beforeEach(() => a.resetStores());
