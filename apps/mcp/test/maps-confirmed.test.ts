import { describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { findMap, sourcedMaps } from '../src/maps.js';
import type { OpenBin } from '../src/session.js';

function baseEntry(): OpenBin {
  const buf = new Uint8Array(256);
  return {
    binId: 'a'.repeat(64), sha256: 'a'.repeat(64), name: 'live.bin', path: 'C:/live.bin',
    size: 256, isFullRead: false, bytes: buf,
    originalBytes: buf, contentSha256: 'a'.repeat(64), changedBytes: 0,
  };
}

const confirmed: MapDef = {
  id: 'c1', name: 'User Dwell', address: 16, rows: 1, cols: 4,
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 1, offset: 0, units: 'ms', digits: 2 },
  orientation: 'row-major', provenance: 'imported',
};

const potential: MapDef = {
  ...confirmed, name: 'auto guess', provenance: 'auto', confidence: 0.5, detector: 'generic',
};

describe('confirmed maps (co-pilot mode)', () => {
  it('sourcedMaps returns them and labels the source', () => {
    const r = sourcedMaps({ ...baseEntry(), confirmed: [confirmed] }, 'confirmed');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ map: confirmed, source: 'confirmed' }]);
  });

  it('names the prerequisite when the app has confirmed nothing', () => {
    const r = sourcedMaps(baseEntry(), 'confirmed');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/has not confirmed any maps/);
  });

  it('"all" includes them alongside detections', () => {
    const entry: OpenBin = {
      ...baseEntry(),
      confirmed: [confirmed],
      scan: { configVersion: 'v1', durationMs: 1, result: { regions: [], potentialMaps: [{ ...potential, id: 'p9' }] } },
    };
    const r = sourcedMaps(entry, 'all');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((s) => s.source).sort()).toEqual(['confirmed', 'potential']);
  });

  it('findMap prefers a confirmed map over a detection with the same id', () => {
    const entry: OpenBin = {
      ...baseEntry(),
      confirmed: [confirmed],
      scan: { configVersion: 'v1', durationMs: 1, result: { regions: [], potentialMaps: [potential] } },
    };
    expect(findMap(entry, 'c1')).toEqual({ map: confirmed, source: 'confirmed' });
  });

  it('findMap still finds a detection the app has not confirmed', () => {
    const entry: OpenBin = {
      ...baseEntry(),
      confirmed: [],
      scan: { configVersion: 'v1', durationMs: 1, result: { regions: [], potentialMaps: [{ ...potential, id: 'p9' }] } },
    };
    expect(findMap(entry, 'p9')?.source).toBe('potential');
  });

  it('headless entries are untouched — no confirmed set, imported still wins', () => {
    const entry: OpenBin = {
      ...baseEntry(),
      imported: { romId: 'R', maps: [{ ...confirmed, name: 'from def' }], warnings: [], frameApplied: 'none' },
      scan: { configVersion: 'v1', durationMs: 1, result: { regions: [], potentialMaps: [potential] } },
    };
    expect(findMap(entry, 'c1')).toMatchObject({ source: 'imported' });
  });
});
