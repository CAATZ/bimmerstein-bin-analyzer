import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { AxisDef } from '@binanalyzer/core';
import { validateMapDef } from '@binanalyzer/core';
import { parseGroundTruth } from '../src/groundtruth.js';
import { fo } from '../src/gt-from-romraider.js';

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
