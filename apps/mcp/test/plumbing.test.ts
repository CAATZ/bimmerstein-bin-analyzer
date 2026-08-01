import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MapDef } from '@binanalyzer/core';
import { asArgs, optAddress, optEnum, optInt, optOneOf, reqAddress, reqString } from '../src/args.js';
import { err, ok } from '../src/result.js';
import { mapKind } from '../src/kind.js';
import { findMap, sourcedMaps } from '../src/maps.js';
import { NodeFileIo } from '../src/fsio.js';
import type { OpenBin } from '../src/session.js';

const FMT = { width: 1, signed: false, endianness: 'little' } as const;
const SCALE = { factor: 1, offset: 0, units: '', digits: 0 };

function map(over: Partial<MapDef> & Pick<MapDef, 'id'>): MapDef {
  return {
    name: over.id, address: 0, rows: 4, cols: 4, format: { ...FMT }, scaling: { ...SCALE },
    orientation: 'row-major', provenance: 'imported', ...over,
  };
}

describe('ok / err', () => {
  it('ok emits one compact JSON text block', () => {
    expect(ok({ a: 1 })).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] });
  });
  it('err flags isError and passes the message through verbatim', () => {
    expect(err('nope')).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
  });
});

describe('args', () => {
  it('asArgs tolerates junk', () => {
    expect(asArgs(undefined)).toEqual({});
    expect(asArgs([1, 2])).toEqual({});
    expect(asArgs({ a: 1 })).toEqual({ a: 1 });
  });

  it('reqString rejects missing and empty', () => {
    expect(reqString({ binId: 'x' }, 'binId')).toEqual({ ok: true, value: 'x' });
    expect(reqString({}, 'binId').ok).toBe(false);
    expect(reqString({ binId: '' }, 'binId').ok).toBe(false);
  });

  it('optInt applies the default and enforces the range', () => {
    expect(optInt({}, 'limit', 50, 1, 200)).toEqual({ ok: true, value: 50 });
    expect(optInt({ limit: 200 }, 'limit', 50, 1, 200)).toEqual({ ok: true, value: 200 });
    expect(optInt({ limit: 201 }, 'limit', 50, 1, 200).ok).toBe(false);
    expect(optInt({ limit: 1.5 }, 'limit', 50, 1, 200).ok).toBe(false);
  });

  it('optEnum / optOneOf', () => {
    expect(optEnum({}, 'sort', ['confidence', 'address'] as const, 'confidence')).toEqual({ ok: true, value: 'confidence' });
    expect(optEnum({ sort: 'address' }, 'sort', ['confidence', 'address'] as const, 'confidence')).toEqual({ ok: true, value: 'address' });
    expect(optEnum({ sort: 'nope' }, 'sort', ['confidence', 'address'] as const, 'confidence').ok).toBe(false);
    expect(optOneOf({}, 'kind', ['grid'] as const)).toEqual({ ok: true, value: undefined });
    expect(optOneOf({ kind: 'grid' }, 'kind', ['grid'] as const)).toEqual({ ok: true, value: 'grid' });
  });

  it('addresses accept decimal integers and 0x-hex strings', () => {
    expect(reqAddress({ address: 4096 }, 'address')).toEqual({ ok: true, value: 4096 });
    expect(reqAddress({ address: '0x1000' }, 'address')).toEqual({ ok: true, value: 4096 });
    expect(reqAddress({ address: '0X1000' }, 'address')).toEqual({ ok: true, value: 4096 });
    expect(reqAddress({ address: '4096' }, 'address')).toEqual({ ok: true, value: 4096 });
    expect(reqAddress({ address: -1 }, 'address').ok).toBe(false);
    expect(reqAddress({ address: '0xzz' }, 'address').ok).toBe(false);
    expect(reqAddress({}, 'address').ok).toBe(false);
    expect(optAddress({}, 'addressMin')).toEqual({ ok: true, value: undefined });
  });
});

describe('mapKind', () => {
  it('classifies switch before curve, then param, then grid', () => {
    expect(mapKind({ rows: 4, cols: 1, states: [{ name: 'On', data: [1, 0, 0, 0] }] })).toBe('switch');
    expect(mapKind({ rows: 1, cols: 1 })).toBe('param');
    expect(mapKind({ rows: 8, cols: 1 })).toBe('curve');
    expect(mapKind({ rows: 1, cols: 8 })).toBe('curve');
    expect(mapKind({ rows: 8, cols: 4 })).toBe('grid');
  });
});

describe('sourcedMaps / findMap', () => {
  const entry: OpenBin = {
    binId: 'a', sha256: 'a', name: 'a.bin', path: '/a.bin', size: 64, isFullRead: false,
    bytes: new Uint8Array(64),
    scan: { configVersion: 'v', durationMs: 1, result: { regions: [], potentialMaps: [map({ id: 'p1', provenance: 'auto', confidence: 0.5 })] } },
    imported: { romId: 'R', warnings: [], frameApplied: 'none', maps: [map({ id: 'i1' })] },
  };

  it('selects by source', () => {
    expect((sourcedMaps(entry, 'potential') as { ok: true; value: unknown[] }).value).toHaveLength(1);
    expect((sourcedMaps(entry, 'imported') as { ok: true; value: unknown[] }).value).toHaveLength(1);
    expect((sourcedMaps(entry, 'all') as { ok: true; value: unknown[] }).value).toHaveLength(2);
  });

  it('names the missing prerequisite', () => {
    // Built by OMISSION, not `scan: undefined` — exactOptionalPropertyTypes
    // rejects an explicit undefined for an optional property.
    const bare: OpenBin = {
      binId: entry.binId, sha256: entry.sha256, name: entry.name, path: entry.path,
      size: entry.size, isFullRead: entry.isFullRead, bytes: entry.bytes,
    };
    expect(sourcedMaps(bare, 'potential')).toEqual({ ok: false, error: expect.stringContaining('scan_bin') });
    expect(sourcedMaps(bare, 'imported')).toEqual({ ok: false, error: expect.stringContaining('import_definition') });
    expect(sourcedMaps(bare, 'all')).toEqual({ ok: true, value: [] });
  });

  it('findMap reports which side an id came from', () => {
    expect(findMap(entry, 'p1')?.source).toBe('potential');
    expect(findMap(entry, 'i1')?.source).toBe('imported');
    expect(findMap(entry, 'nope')).toBeUndefined();
  });
});

describe('NodeFileIo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'binmcp-'));
  const io = new NodeFileIo();

  it('reads a bin with its basename and resolved path', () => {
    const p = join(dir, 'x.bin');
    writeFileSync(p, Buffer.from([1, 2, 3, 4]));
    const r = io.readBin(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Array.from(r.value.bytes)).toEqual([1, 2, 3, 4]);
      expect(r.value.name).toBe('x.bin');
    }
  });

  it('rejects a missing file, a directory and an empty file', () => {
    expect(io.readBin(join(dir, 'nope.bin')).ok).toBe(false);
    expect(io.readBin(dir).ok).toBe(false);
    const e = join(dir, 'empty.bin');
    writeFileSync(e, Buffer.alloc(0));
    expect(io.readBin(e)).toEqual({ ok: false, error: expect.stringContaining('empty') });
  });

  it('reads text and reports a missing text file as an error', () => {
    const p = join(dir, 'a.xml');
    writeFileSync(p, '<roms/>', 'utf8');
    expect(io.readText(p)).toEqual({ ok: true, value: '<roms/>' });
    expect(io.readText(join(dir, 'no.xml')).ok).toBe(false);
  });
});
