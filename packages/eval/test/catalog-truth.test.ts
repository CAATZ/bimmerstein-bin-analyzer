import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createBinImage, type MapDef } from '@binanalyzer/core';
import { buildCatalogGroundTruth, fo } from '../src/gt-from-romraider.js';
import type { GroundTruth } from '../src/groundtruth.js';

const map = (address: number, rows = 1, cols = 1): MapDef => ({
  id: 'source', name: 'Private name', category: 'Private category', notes: 'Private notes',
  address, rows, cols, format: { width: 1, signed: true, endianness: 'little' },
  scaling: { factor: 3, offset: 1, units: 'Private units', digits: 2 },
  orientation: 'row-major', provenance: 'imported',
});
const opts = { fixture: 'catalog', idPrefix: 'catalog', applyFo: false };

describe('complete catalog truth', () => {
  it('retains all 670 structural objects in equivalent full and partial address frames', () => {
    for (const [cls, count] of [['grid', 110], ['curve', 140], ['param', 420]] as const) {
      const read = (frame: string): GroundTruth => JSON.parse(readFileSync(new URL(
        `../../../fixtures/references/reference-ms41-id41-catalog-${frame}-${cls}.groundtruth.json`, import.meta.url
      ), 'utf8')) as GroundTruth;
      const partial = read('partial');
      const full = read('full');
      expect(partial.maps).toHaveLength(count);
      expect(full.maps).toHaveLength(count);
      expect(partial.binSha256).toBe('291c5d140151e00949014d651cedba35a06f466477afab1ef8a93947cc8c6c45');
      expect(full.binSha256).toBe('c61674c5812f5fe0a4a6f86e96311e9a8e540a905f9e7f681fdd045254249521');
      for (const m of partial.maps) {
        const counterpart = full.maps.find(f => f.address === fo(m.address))!;
        expect(counterpart).toBeDefined();
        expect(counterpart).toMatchObject({ rows: m.rows, cols: m.cols, format: m.format, orientation: m.orientation });
        for (const role of ['xAxis', 'yAxis'] as const) {
          const axis = m[role];
          expect(counterpart[role]).toEqual(axis?.kind === 'referenced' ? { ...axis, address: fo(axis.address!) } : axis);
        }
      }
      for (const m of [...full.maps, ...partial.maps]) {
        expect(m.name).toBe(m.id);
        expect(m.scaling).toEqual({ factor: 1, offset: 0, units: '', digits: 0 });
        expect([m.category, m.notes, m.states]).toEqual([undefined, undefined, undefined]);
      }
    }
  });
  it('retains zero-filled grids, curves and scalars while removing authored metadata', () => {
    const curve = { ...map(0x20, 1, 4), xAxis: { kind: 'referenced' as const, address: 0x10, count: 4,
      format: { width: 1 as const, signed: false, endianness: 'little' as const }, name: 'Private axis' } };
    const scalar = { ...map(4), format: { width: 1 as const, signed: false, endianness: 'little' as const },
      scaling: { factor: 1, offset: 0, units: 'Private units', digits: 0 },
      states: [{ name: 'Private state', data: [0] }, { name: 'Private alternate', data: [1] }] };
    const result = buildCatalogGroundTruth([map(0x30, 2, 2), curve, scalar], createBinImage(new Uint8Array(128), 'b'), opts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maps.map(m => m.address)).toEqual([4, 0x20, 0x30]);
    expect(result.value.maps[1]).toMatchObject({ rows: 4, cols: 1, format: { signed: true }, yAxis: { count: 4, address: 0x10 } });
    expect(JSON.stringify(result.value)).not.toContain('Private');
    expect(result.value.maps.every(m => m.name === m.id && m.scaling.factor === 1)).toBe(true);
  });

  it('maps each full-ROM address and rejects a structure crossing the calibration seam', () => {
    const bin = createBinImage(new Uint8Array(0x40000), 'b');
    const full = { ...opts, applyFo: true };
    const result = buildCatalogGroundTruth([map(0x4002)], bin, full);
    expect(result.ok && result.value.maps[0]!.address).toBe(0x10002);
    expect(buildCatalogGroundTruth([map(0x3fff, 2, 2)], bin, full).ok).toBe(false);
  });

  it('rejects duplicate starts and invalid axes instead of silently dropping catalog entries', () => {
    const bin = createBinImage(new Uint8Array(128), 'b');
    expect(buildCatalogGroundTruth([map(4), map(4)], bin, opts).ok).toBe(false);
    const bad = { ...map(8, 3, 1), yAxis: { kind: 'referenced' as const, address: 127, count: 3,
      format: { width: 1 as const, signed: false, endianness: 'little' as const } } };
    expect(buildCatalogGroundTruth([bad], bin, opts).ok).toBe(false);
  });
});
