import { existsSync, readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createBinImage, readGrid, validateMapDef } from '@binanalyzer/core';
import { DEFAULT_SCAN_CONFIG, scan } from '@binanalyzer/engine';
import { importRomRaiderXml } from '@binanalyzer/formats';
import { fo } from '../src/gt-from-romraider.js';

const definition = new URL('../../../fixtures/maf/defs/reference.xml', import.meta.url);
const cases = [
  ['59', '0940cf88d79ac0695fb2f86b8554d64a9c088fe14bab81e385add2caf6ba1774', 0x2892],
  ['59', 'ee1f0e61762e3db62bac47535990a1f4ca636852f8fe30d9b044ea5a4bf3c606', 0x2892],
  ['59', 'd38e5a62ac0c788f8e9f1331a4aeb17e45daf3fc94e3738c4a6d67b30b3c1be0', 0x2892],
  ['42', 'ae1784edd38f1d34d636397ab17f4cfc5952651d976bdbd1fdcb90c0cae46b3c', 0x2c74],
  ['42', 'f5e6d458b3ac0bbebce4740e7cf75f6661b7c581e79f0600fbcefd9edd05f9c7', 0x2c74],
] as const;

for (const [rom, sha, sa] of cases) {
  const key = `id${rom}-${sha.slice(0, 8)}`;
  const file = new URL(`../../../fixtures/maf/${key}.bin`, import.meta.url);
  it.skipIf(!existsSync(file) || !existsSync(definition))(`preserves both MAF views and word detection in full/partial ${key}`, async () => {
    const full = new Uint8Array(readFileSync(file));
    expect(full.length).toBe(0x40000);
    expect(createBinImage(full, key).sha256).toBe(sha);
    const xml = new Uint8Array(readFileSync(definition));
    expect(createBinImage(xml, 'reference').sha256).toBe('ca1af15438b9849d60ec8540a04d145d76d51bcecdb714593fe9e35e16f50a64');
    const imported = importRomRaiderXml(new TextDecoder().decode(xml), rom);
    if (!imported.ok) throw new Error(imported.error);
    const aliases = imported.value.maps.filter(m => m.address === sa && m.name.startsWith('MAF'));
    expect(aliases).toHaveLength(2);
    expect(aliases.map(m => [m.rows, m.cols]).sort()).toEqual([[16, 16], [256, 1]]);
    const grid = aliases.find(m => m.cols === 16)!;
    expect(grid.xAxis).toMatchObject({ kind: 'literal', count: 16 });
    expect(grid.yAxis).toMatchObject({ kind: 'literal', count: 16 });
    const partial = Uint8Array.from({ length: 0x6000 }, (_, i) => full[fo(i)]!);
    const raw = readGrid(partial, grid).flat();
    for (const bytes of [full, partial]) {
      await setImmediate(); // Let the test worker deliver results between synchronous scans.
      const address = bytes === full ? fo(sa) : sa;
      const found = scan(bytes, DEFAULT_SCAN_CONFIG).potentialMaps.filter(m => m.address === address);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ rows: 16, cols: 16, format: { width: 2, signed: false, endianness: 'little' } });
      expect(found[0]!.xAxis).toBeUndefined();
      expect(found[0]!.yAxis).toBeUndefined();
      expect(readGrid(bytes, found[0]!).flat()).toEqual(raw);
      for (const alias of aliases) {
        const framed = { ...alias, address };
        expect(validateMapDef(framed, bytes.length).ok).toBe(true);
        expect(readGrid(bytes, framed).flat()).toEqual(raw);
      }
    }
  }, 60_000);
}
