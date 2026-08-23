import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBinImage } from '@binanalyzer/core';
import type { MapPack } from '@binanalyzer/formats';
import * as a from '../src/store/actions.js';
import { classifyPack } from '../src/lib/packapply.js';
import { checksumReport, editJournal, workingBytes } from '../src/store/stores.js';
import { clearUndo, undo } from '../src/store/undo.js';
import { ms41TuneImage } from './ms41-image.js';

const pack = (
  address: number,
  values: number[][],
  baseline: number[][],
  orientation: 'row-major' | 'col-major' = 'row-major'
): MapPack => ({
  schemaVersion: 1,
  source: { familyId: 'ms41', calId: '12', binSha256: 'a'.repeat(64) },
  title: 'T',
  tables: [
    {
      name: 'T',
      address,
      rows: 2,
      cols: 2,
      orientation,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      values,
      baseline,
    },
  ],
});

const seed = (): void => {
  a.resetStores();
  a.setBin(createBinImage(new Uint8Array(64).fill(9), 'e.bin'));
  clearUndo();
};
const rawAt = (o: number): number => get(workingBytes)![o]!;
const rowsFor = (p: MapPack) =>
  classifyPack({ pack: p, bytes: get(workingBytes)!, binIsFullRead: false });

describe('applyPackRows', () => {
  beforeEach(seed);

  it('writes every cell of a checked table', () => {
    const rows = rowsFor(
      pack(
        0x10,
        [
          [1, 2],
          [3, 4],
        ],
        [
          [9, 9],
          [9, 9],
        ]
      )
    );
    expect(a.applyPackRows(rows)).toEqual({ tables: 1, changedBytes: 4 });
    expect([rawAt(0x10), rawAt(0x11), rawAt(0x12), rawAt(0x13)]).toEqual([1, 2, 3, 4]);
  });

  it('is ONE undo step that reverts the BUFFER, not just the journal', () => {
    const rows = rowsFor(
      pack(
        0x10,
        [
          [1, 2],
          [3, 4],
        ],
        [
          [9, 9],
          [9, 9],
        ]
      )
    );
    a.applyPackRows(rows);
    expect(get(editJournal).size).toBe(4);

    expect(undo()).toBe(true);
    expect([rawAt(0x10), rawAt(0x11), rawAt(0x12), rawAt(0x13)]).toEqual([9, 9, 9, 9]);
    expect(get(editJournal).size).toBe(0);
    expect(undo()).toBe(false); // exactly ONE entry, not one per cell
  });

  it('skips an incompatible row rather than writing it', () => {
    const rows = rowsFor(
      pack(
        63,
        [
          [1, 2],
          [3, 4],
        ],
        [
          [9, 9],
          [9, 9],
        ]
      )
    );
    expect(rows[0]!.klass).toBe('incompatible');
    expect(a.applyPackRows(rows)).toEqual({ tables: 0, changedBytes: 0 });
    expect(get(editJournal).size).toBe(0);
  });

  it('counts only the bytes that actually move', () => {
    // Two of four cells already hold the pack's value.
    const rows = rowsFor(
      pack(
        0x10,
        [
          [9, 2],
          [9, 4],
        ],
        [
          [9, 9],
          [9, 9],
        ]
      )
    );
    expect(a.applyPackRows(rows)).toEqual({ tables: 1, changedBytes: 2 });
  });

  it('counts BYTES, not cells — a 16-bit cell moves two of them', () => {
    // Measured on real firmware during GUI acceptance: one 16-bit cell plus one
    // 8-bit cell reported "2 bytes changed" while the file diff showed 3.
    const p: MapPack = {
      schemaVersion: 1,
      source: { familyId: 'ms41', calId: '12', binSha256: 'a'.repeat(64) },
      title: 'T',
      tables: [
        {
          name: 'wide',
          address: 0x10,
          rows: 1,
          cols: 1,
          orientation: 'row-major',
          format: { width: 2, signed: false, endianness: 'little' },
          scaling: { factor: 1, offset: 0, units: '', digits: 0 },
          values: [[0x1234]],
          baseline: [[0x0909]],
        },
      ],
    };
    expect(a.applyPackRows(rowsFor(p))).toEqual({ tables: 1, changedBytes: 2 });
  });

  it('does not count a byte inside a wide cell that did not move', () => {
    // 0x0909 -> 0x0934: the high byte is unchanged, so only ONE byte moved.
    const p: MapPack = {
      schemaVersion: 1,
      source: { familyId: 'ms41', calId: '12', binSha256: 'a'.repeat(64) },
      title: 'T',
      tables: [
        {
          name: 'wide',
          address: 0x10,
          rows: 1,
          cols: 1,
          orientation: 'row-major',
          format: { width: 2, signed: false, endianness: 'little' },
          scaling: { factor: 1, offset: 0, units: '', digits: 0 },
          values: [[0x0934]],
          baseline: [[0x0909]],
        },
      ],
    };
    expect(a.applyPackRows(rowsFor(p))).toEqual({ tables: 1, changedBytes: 1 });
  });

  it('pushes NO undo entry when the caller passes nothing applicable', () => {
    const rows = rowsFor(
      pack(
        63,
        [
          [1, 2],
          [3, 4],
        ],
        [
          [9, 9],
          [9, 9],
        ]
      )
    );
    a.applyPackRows(rows);
    // A refused apply must not leave a phantom step for the user to undo.
    expect(undo()).toBe(false);
  });

  it('writes a col-major table down the column', () => {
    const rows = rowsFor(
      pack(
        0x10,
        [
          [1, 2],
          [3, 4],
        ],
        [
          [9, 9],
          [9, 9],
        ],
        'col-major'
      )
    );
    a.applyPackRows(rows);
    // Down columns: (0,0)=1 (1,0)=3 (0,1)=2 (1,1)=4.
    expect([rawAt(0x10), rawAt(0x11), rawAt(0x12), rawAt(0x13)]).toEqual([1, 3, 2, 4]);
  });

  it('re-verifies checksums ONCE after the batch', () => {
    a.resetStores();
    a.setBin(createBinImage(ms41TuneImage(), 'tune.bin'));
    a.runChecksumVerify();
    clearUndo();
    const before = get(checksumReport);
    expect(before).toBeDefined();

    const at = 0x1200;
    const cur = get(workingBytes)![at]!;
    const rows = rowsFor(
      pack(
        at,
        [
          [cur ^ 0xff, cur],
          [cur, cur],
        ],
        [
          [cur, cur],
          [cur, cur],
        ]
      )
    );
    a.applyPackRows(rows);
    expect(get(checksumReport)).not.toBe(before);
  });
});
