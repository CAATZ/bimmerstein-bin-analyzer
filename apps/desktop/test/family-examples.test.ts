import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { crc16 } from '@binanalyzer/families';
import { DEFAULT_SCAN_CONFIG, rankAndEmit } from '@binanalyzer/engine';
import { loadFamilyModule } from '../src/lib/familyloader.js';
import { demoAnalyzer } from '../../../examples/families/demo-analyzer.js';

function sample(): Uint8Array {
  const bytes = new Uint8Array(128);
  bytes.set([0x42, 0x46, 0x41, 0x4d, 1, 7, 4, 6]);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 0x20, true);
  view.setUint16(10, 0x2c, true);
  view.setUint16(12, 0x34, true);
  [500, 1000, 2000, 3000, 4000, 6000].forEach((v, i) => view.setUint16(0x20 + 2 * i, v, true));
  [10, 20, 40, 80].forEach((v, i) => view.setUint16(0x2c + 2 * i, v, true));
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) view.setUint16(0x34 + 2 * (row * 6 + col), 1000 + row * 100 + col * 10, true);
  }
  view.setUint16(126, crc16(bytes.subarray(0, 126), 0), true);
  return bytes;
}

function module() {
  const source = readFileSync(new URL('../../../examples/families/demo-checksums.js', import.meta.url), 'utf8');
  const loaded = loadFamilyModule(source);
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

describe('published family examples', () => {
  it('loads through the app and corrects only checksum bytes without mutating a byte view', () => {
    const mod = module();
    const backing = new Uint8Array(144).fill(0xa5);
    backing.set(sample(), 8);
    const bytes = backing.subarray(8, 136);
    expect(mod.identify(bytes)).toEqual({ familyId: 'demo-bfam', calId: '7' });
    expect(mod.verify(bytes).valid).toBe(true);
    bytes[0x34] = bytes[0x34]! ^ 1;
    expect(mod.applies(bytes)).toBe(true);
    expect(mod.verify(bytes).valid).toBe(false);
    const before = backing.slice();
    const result = mod.correct(bytes);
    expect(backing).toEqual(before);
    expect(result.bytes).not.toBe(bytes);
    expect(result.bytes.slice(0, 126)).toEqual(bytes.slice(0, 126));
    const expected = crc16(bytes.subarray(0, 126), 0);
    expect([...result.bytes.slice(126)]).toEqual([expected & 0xff, expected >>> 8]);
    expect(result.report).toEqual(mod.verify(result.bytes));
    expect(result.report.valid).toBe(true);
    expect(result.changed).toEqual([126, 127].filter(offset => bytes[offset] !== result.bytes[offset])
      .map(offset => ({ offset, from: bytes[offset], to: result.bytes[offset] })));
    expect(result.changed.length).toBeGreaterThan(0);
    expect(mod.correct(result.bytes).changed).toEqual([]);
  });

  it('keeps both examples inert on other signatures, versions and truncated images', () => {
    const mod = module();
    const signature = sample(); signature[0] = 0;
    const version = sample(); version[4] = 2;
    for (const bytes of [new Uint8Array(), sample().subarray(0, 127), signature, version]) {
      const before = bytes.slice();
      expect(mod.applies(bytes)).toBe(false);
      expect(mod.identify(bytes)).toBeUndefined();
      expect(mod.verify(bytes)).toMatchObject({ applies: false, valid: false, blocks: [] });
      expect(mod.correct(bytes)).toMatchObject({ bytes: before, changed: [] });
      expect(demoAnalyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG)).toEqual([]);
      expect(bytes).toEqual(before);
    }
  });

  it('emits exact row-major word offsets and axis roles through the production ranker', () => {
    const backing = new Uint8Array(144);
    backing.set(sample(), 8);
    const bytes = backing.subarray(8, 136);
    const before = bytes.slice();
    const found = demoAnalyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      address: 0x34, rows: 4, cols: 6, format: { width: 2, signed: false, endianness: 'little' },
      xAxis: { address: 0x20, count: 6 }, yAxis: { address: 0x2c, count: 4 },
    });
    expect(demoAnalyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG)).toEqual(found);
    expect(bytes).toEqual(before);
    const maps = rankAndEmit(bytes, [], [], DEFAULT_SCAN_CONFIG, [], found);
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ address: 0x34, orientation: 'row-major', detector: 'family',
      xAxis: { kind: 'referenced', count: 6 }, yAxis: { kind: 'referenced', count: 4 } });
    const relocated = bytes.slice();
    new DataView(relocated.buffer).setUint16(12, 0x36, true);
    expect(demoAnalyzer.analyze(relocated, [], DEFAULT_SCAN_CONFIG)[0]?.address).toBe(0x36);
    const limits = { ...DEFAULT_SCAN_CONFIG, table: { ...DEFAULT_SCAN_CONFIG.table, maxCols: 5 } };
    expect(demoAnalyzer.analyze(bytes, [], limits)).toEqual([]);
  });

  it('rejects invalid dimensions, overlaps, unaligned words and spans entering the checksum', () => {
    for (const [offset, value] of [[6, 0], [8, 12], [8, 0x21], [8, 126], [10, 0x20], [12, 0x30], [12, 100]]) {
      const bytes = sample();
      bytes[offset!] = value!;
      expect(demoAnalyzer.analyze(bytes, [], DEFAULT_SCAN_CONFIG)).toEqual([]);
    }
  });
});
