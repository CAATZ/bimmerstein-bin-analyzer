import { describe, expect, it } from 'vitest';
import { parsePack, serializePack, type MapPack } from '../src/mappack.js';

const pack = (over: Partial<MapPack> = {}): MapPack => ({
  schemaVersion: 1,
  source: {
    familyId: 'ms41',
    calId: '12',
    binSha256: 'a'.repeat(64),
    addressFrame: 'ms41full',
  },
  title: 'S52 Stage 1',
  tables: [
    {
      name: 'Ignition Main',
      address: 91964,
      rows: 2,
      cols: 2,
      orientation: 'row-major',
      format: { width: 1, signed: false, endianness: 'big' },
      scaling: { factor: 0.75, offset: 0, units: '°', digits: 2 },
      values: [
        [8, 9],
        [10, 11],
      ],
      baseline: [
        [8, 8],
        [10, 10],
      ],
    },
  ],
  ...over,
});

describe('map pack round trip', () => {
  it('survives serialize -> parse unchanged', () => {
    const r = parsePack(serializePack(pack()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(pack());
  });

  it('is byte-stable — serializing a parsed pack reproduces the text', () => {
    const once = serializePack(pack());
    const r = parsePack(once);
    expect(r.ok).toBe(true);
    if (r.ok) expect(serializePack(r.value)).toBe(once);
  });

  it('carries notes when present and omits them when absent', () => {
    expect(serializePack(pack({ notes: 'hi' }))).toContain('"notes"');
    expect(serializePack(pack())).not.toContain('"notes"');
  });

  it('ends with a newline, so the file is well-formed text', () => {
    expect(serializePack(pack()).endsWith('\n')).toBe(true);
  });
});

describe('map pack validation', () => {
  it('rejects invalid float formats and display precision before previewing a pack', () => {
    const bad = pack();
    bad.tables[0]!.format.float = true;
    expect(parsePack(serializePack(bad)).ok).toBe(false);
    bad.tables[0]!.format = { width: 4, signed: false, endianness: 'little' };
    for (const float of ['false', 1]) {
      expect(parsePack(JSON.stringify({ ...bad, tables: [{ ...bad.tables[0], format: { ...bad.tables[0]!.format, float } }] })).ok).toBe(false);
    }
    for (const digits of [-1, 101]) {
      bad.tables[0]!.scaling.digits = digits;
      expect(parsePack(serializePack(bad)).ok).toBe(false);
    }
  });

  const err = (json: string): string => {
    const r = parsePack(json);
    return r.ok ? '(unexpectedly ok)' : r.error;
  };

  it('rejects invalid JSON', () => {
    expect(err('{oops')).toContain('invalid JSON');
  });

  it('rejects an unsupported schemaVersion, naming what it supports', () => {
    const e = err(serializePack(pack()).replace('"schemaVersion": 1', '"schemaVersion": 2'));
    expect(e).toContain('schemaVersion');
    expect(e).toContain('1');
  });

  it('rejects a bad sha256', () => {
    expect(err(serializePack(pack()).replace('a'.repeat(64), 'nope'))).toContain('binSha256');
  });

  it('rejects a table whose values do not match rows x cols', () => {
    const bad = pack();
    bad.tables[0]!.values = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(err(serializePack(bad))).toContain('values');
  });

  it('rejects a table whose baseline does not match rows x cols', () => {
    const bad = pack();
    bad.tables[0]!.baseline = [[1]];
    expect(err(serializePack(bad))).toContain('baseline');
  });

  it('rejects an empty tables array — a pack with nothing in it is a mistake', () => {
    expect(err(serializePack(pack({ tables: [] })))).toContain('tables');
  });

  it('rejects a non-integer address', () => {
    const bad = pack();
    (bad.tables[0] as { address: number }).address = 1.5;
    expect(err(serializePack(bad))).toContain('address');
  });

  it('rejects a non-numeric cell rather than coercing it', () => {
    const bad = JSON.parse(serializePack(pack())) as MapPack;
    (bad.tables[0]!.values[0] as unknown[])[0] = '8';
    expect(err(JSON.stringify(bad))).toContain('finite number');
  });

  it('names the table and cell that is wrong, so a bad pack is diagnosable', () => {
    const bad = pack();
    bad.tables[0]!.values = [
      [1, 2],
      [3, Number.NaN],
    ];
    expect(err(serializePack(bad))).toContain('tables[0].values[1][1]');
  });
});
