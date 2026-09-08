import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { AxisDef } from '@binanalyzer/core';
import { createBinImage, validateMapDef } from '@binanalyzer/core';
import { DEFAULT_SCAN_CONFIG, scan } from '@binanalyzer/engine';
import { parseGroundTruth } from '../src/groundtruth.js';
import { fo } from '../src/gt-from-romraider.js';
import { scoreDetections } from '../src/metrics.js';

it('keeps every expanded reference class valid and identical across address frames', () => {
  const counts = { ss1v2: [100, 137, 187], id60: [71, 94, 449], id12: [73, 108, 163] };
  const mapAxis = (axis: AxisDef | undefined) => axis?.address === undefined ? axis : { ...axis, address: fo(axis.address) };
  for (const [rom, sizes] of Object.entries(counts)) {
    for (const [index, shape] of ['grid', 'curve', 'param'].entries()) {
      const load = (frame: string) => {
        const key = `reference-ms41-${rom}-expanded-${frame}-${shape}`;
        const parsed = parseGroundTruth(readFileSync(new URL(`../../../fixtures/references/${key}.groundtruth.json`, import.meta.url), 'utf8'));
        if (!parsed.ok) throw new Error(parsed.error);
        expect(parsed.value.fixture).toBe(key);
        expect(parsed.value.maps).toHaveLength(sizes[index]!);
        for (const m of parsed.value.maps) expect(validateMapDef(m, frame === 'full' ? 262144 : 24576).ok).toBe(true);
        return parsed.value;
      };
      const partial = load('partial');
      const full = load('full');
      expect(full.binSha256).not.toBe(partial.binSha256);
      expect(full.maps).toEqual(partial.maps.map((m) => ({
        ...m, id: m.id.replace('-partial-', '-full-'), name: m.name.replace('-partial-', '-full-'), address: fo(m.address),
        ...(m.xAxis ? { xAxis: mapAxis(m.xAxis) } : {}),
        ...(m.yAxis ? { yAxis: mapAxis(m.yAxis) } : {}),
      })).sort((a, b) => a.address - b.address));
    }
  }
});

for (const rom of ['ss1v2', 'id60', 'id12']) {
  const bin = new URL('../../../fixtures/references/reference-ms41-' + rom + '-expanded-full-grid.bin', import.meta.url);
  it.skipIf(!existsSync(bin))('preserves recovered addresses and layouts in the exact ' + rom + ' full image', () => {
    const bytes = new Uint8Array(readFileSync(bin));
    const sha = createBinImage(bytes, rom).sha256;
    const truth = ['grid', 'curve', 'param'].flatMap(shape => {
      const path = new URL('../../../fixtures/references/reference-ms41-' + rom + '-expanded-full-' + shape + '.groundtruth.json', import.meta.url);
      const parsed = parseGroundTruth(readFileSync(path, 'utf8'));
      if (!parsed.ok) throw new Error(parsed.error);
      expect(parsed.value.binSha256).toBe(sha);
      return parsed.value.maps;
    });
    const addresses = [4, 5, 6, 7, 8, ...(rom === 'ss1v2' ? [0x11a8, 0x3466, 0x34a8, 0x34ea, 0x352c, 0x3440, 0x42c8] : [])];
    const detected = scan(bytes, DEFAULT_SCAN_CONFIG).potentialMaps;
    for (const sa of addresses) {
      const expected = truth.find(m => m.address === fo(sa));
      expect(expected, sa.toString(16)).toBeDefined();
      if (!expected) throw new Error('Missing reference address');
      const scores = scoreDetections(detected, [expected], bytes.length);
      expect(scores.exactStartRecall, sa.toString(16)).toBe(1);
      expect(scores.exactLayoutRecall, sa.toString(16)).toBe(1);
      if ([expected.xAxis, expected.yAxis].some(axis => axis && axis.kind !== 'index')) {
        expect(scores.axisPairRecall, sa.toString(16)).toBe(1);
      }
    }
  }, 30_000);
}
