import { describe, expect, it } from 'vitest';
import type { MapPack, PackTable } from '@binanalyzer/formats';
import { classifyPack, packGateError } from '../src/lib/packapply.js';

const table = (over: Partial<PackTable> = {}): PackTable => ({
  name: 'T',
  address: 0x10,
  rows: 2,
  cols: 2,
  orientation: 'row-major',
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 1, offset: 0, units: '', digits: 0 },
  values: [
    [1, 2],
    [3, 4],
  ],
  baseline: [
    [9, 9],
    [9, 9],
  ],
  ...over,
});

const pack = (over: Partial<MapPack> = {}): MapPack => ({
  schemaVersion: 1,
  source: { familyId: 'ms41', calId: '12', binSha256: 'a'.repeat(64) },
  title: 'T',
  tables: [table()],
  ...over,
});

/** 64 bytes, every byte 9 — matches the default baseline. */
const bytes = (): Uint8Array => new Uint8Array(64).fill(9);

describe('packGateError', () => {
  it('passes when the CAL-ID matches', () => {
    expect(packGateError(pack(), { familyId: 'ms41', calId: '12' })).toBeUndefined();
  });

  it('refuses a different CAL-ID and NAMES BOTH', () => {
    const e = packGateError(pack(), { familyId: 'ms41', calId: '41' })!;
    expect(e).toContain('12');
    expect(e).toContain('41');
  });

  it('refuses a bin that cannot be identified rather than assuming', () => {
    expect(packGateError(pack(), undefined)).toMatch(/identif/i);
  });

  it('refuses a pack built for a different family, naming both', () => {
    // The reachable direction: a bin's familyId is core's closed union, but a
    // pack may name any family — including one this build does not have.
    const p = pack({ source: { familyId: 'me7', calId: '12', binSha256: 'a'.repeat(64) } });
    const e = packGateError(p, { familyId: 'ms41', calId: '12' })!;
    expect(e).toContain('me7');
    expect(e).toContain('ms41');
  });
});

describe('classifyPack', () => {
  it('marks a table READY when the bin matches the baseline', () => {
    const rows = classifyPack({ pack: pack(), bytes: bytes(), binIsFullRead: false });
    expect(rows[0]!.klass).toBe('ready');
    expect(rows[0]!.changedCells).toBe(4);
  });

  it('marks MODIFIED when the bin differs from the baseline, and says which cells', () => {
    const b = bytes();
    b[0x11] = 7; // one cell diverges from baseline 9
    const rows = classifyPack({ pack: pack(), bytes: b, binIsFullRead: false });
    expect(rows[0]!.klass).toBe('modified');
    expect(rows[0]!.divergedCells).toEqual([{ row: 0, col: 1, mine: 7, theirBaseline: 9 }]);
  });

  it('marks NO CHANGE when the pack values already equal the bin', () => {
    const b = bytes();
    b[0x10] = 1;
    b[0x11] = 2;
    b[0x12] = 3;
    b[0x13] = 4;
    const rows = classifyPack({
      pack: pack({
        tables: [
          table({
            baseline: [
              [1, 2],
              [3, 4],
            ],
          }),
        ],
      }),
      bytes: b,
      binIsFullRead: false,
    });
    expect(rows[0]!.klass).toBe('no-change');
    expect(rows[0]!.changedCells).toBe(0);
  });

  it('marks INCOMPATIBLE when the table runs past the end of the bin', () => {
    const rows = classifyPack({
      pack: pack({ tables: [table({ address: 63 })] }),
      bytes: bytes(),
      binIsFullRead: false,
    });
    expect(rows[0]!.klass).toBe('incompatible');
    expect(rows[0]!.reason).toMatch(/outside|bin/i);
  });

  it('reports before/after per cell for the drill-down', () => {
    const rows = classifyPack({ pack: pack(), bytes: bytes(), binIsFullRead: false });
    expect(rows[0]!.cells[0]).toEqual({ row: 0, col: 0, before: 9, after: 1 });
  });

  it('reads col-major tables down the column, not across the row', () => {
    const b = bytes();
    // Column-major: cell (0,1) is the THIRD byte, not the second.
    b[0x10] = 10;
    b[0x11] = 11;
    b[0x12] = 12;
    b[0x13] = 13;
    const rows = classifyPack({
      pack: pack({ tables: [table({ orientation: 'col-major' })] }),
      bytes: b,
      binIsFullRead: false,
    });
    const at = (r: number, c: number): number =>
      rows[0]!.cells.find((x) => x.row === r && x.col === c)!.before;
    expect(at(0, 1)).toBe(12);
    expect(at(1, 0)).toBe(11);
  });

  it('classifies each table independently, so one bad table does not sink the rest', () => {
    const rows = classifyPack({
      pack: pack({ tables: [table(), table({ name: 'far', address: 900 })] }),
      bytes: bytes(),
      binIsFullRead: false,
    });
    expect(rows.map((r) => r.klass)).toEqual(['ready', 'incompatible']);
    expect(rows[1]!.index).toBe(1);
  });

  it('NEVER mutates the buffer it classifies', () => {
    const b = bytes();
    const copy = b.slice();
    classifyPack({ pack: pack(), bytes: b, binIsFullRead: false });
    expect([...b]).toEqual([...copy]);
  });
});

describe('frame conversion', () => {
  it('converts a full-read pack onto a partial bin', () => {
    // fo(SA) = (0x10000+SA)^0x4000, so SA 0x10 lives at 0x14010 on a full read.
    const p = pack({
      source: { familyId: 'ms41', calId: '12', binSha256: 'a'.repeat(64), addressFrame: 'ms41full' },
      tables: [table({ address: 0x14010 })],
    });
    const b = new Uint8Array(0x6000).fill(9);
    const rows = classifyPack({ pack: p, bytes: b, binIsFullRead: false });
    expect(rows[0]!.klass).toBe('ready');
    expect(rows[0]!.address).toBe(0x10);
  });

  it('leaves addresses alone when both sides share a frame', () => {
    const p = pack({
      source: { familyId: 'ms41', calId: '12', binSha256: 'a'.repeat(64), addressFrame: 'ms41full' },
      tables: [table({ address: 0x14010 })],
    });
    const b = new Uint8Array(0x40000).fill(9);
    const rows = classifyPack({ pack: p, bytes: b, binIsFullRead: true });
    expect(rows[0]!.address).toBe(0x14010);
  });

  it('reports WHY a table cannot be reframed, rather than a generic refusal', () => {
    // An address with no cal-window representation cannot cross frames.
    const p = pack({
      source: { familyId: 'ms41', calId: '12', binSha256: 'a'.repeat(64), addressFrame: 'ms41full' },
      tables: [table({ address: 0x100 })],
    });
    const rows = classifyPack({ pack: p, bytes: new Uint8Array(0x6000).fill(9), binIsFullRead: false });
    expect(rows[0]!.klass).toBe('incompatible');
    // Asserts the FRAMING HELPER's own reason was surfaced, not just our
    // wrapper text — /frame/i alone would match the wrapper and pass vacuously.
    expect(rows[0]!.reason).toContain('cal window');
  });
});
