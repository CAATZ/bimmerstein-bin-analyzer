import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_SCAN_CONFIG, scanPrefixedAxes } from '@binanalyzer/engine';
import { call, errorText, fakeDeps, payload } from './helpers.js';
import { listDetectedAxesTool, openBinTool } from '../src/tools/index.js';

const SYNTH1 = new Uint8Array(readFileSync(new URL('../../../fixtures/synthetic/synth-1.bin', import.meta.url)));

interface AxisPage {
  total: number;
  returned: number;
  hasMore: boolean;
  axes: Array<Record<string, unknown>>;
}

async function opened(): Promise<{ deps: ReturnType<typeof fakeDeps>; binId: string }> {
  const deps = fakeDeps({ bins: { '/b/s1.bin': SYNTH1 } });
  const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/s1.bin' }, deps));
  return { deps, binId };
}

describe('list_detected_axes', () => {
  it('matches a direct scanPrefixedAxes sweep over a synthetic full-range data region', async () => {
    const { deps, binId } = await opened();
    const direct = scanPrefixedAxes(SYNTH1, [{ start: 0, end: SYNTH1.length, kind: 'data' }], DEFAULT_SCAN_CONFIG).filter((p) => p.maximal);
    const r = payload<AxisPage>(await call(listDetectedAxesTool, { binId, limit: 500 }, deps));
    expect(r.total).toBe(direct.length);
  });

  it('does not require a scan and is stable across repeat calls', async () => {
    const { deps, binId } = await opened();
    const a = payload<AxisPage>(await call(listDetectedAxesTool, { binId, limit: 500 }, deps));
    const b = payload<AxisPage>(await call(listDetectedAxesTool, { binId, limit: 500 }, deps));
    expect(b).toEqual(a);
  });

  it('returns addresses ascending with a prefixAddress one cell-width back', async () => {
    const { deps, binId } = await opened();
    const r = payload<AxisPage>(await call(listDetectedAxesTool, { binId, limit: 500 }, deps));
    const addrs = r.axes.map((x) => x['address'] as number);
    expect([...addrs].sort((p, q) => p - q)).toEqual(addrs);
    for (const x of r.axes) {
      expect(x['prefixAddress']).toBe((x['address'] as number) - ((x['format'] as { width: number }).width));
      expect(x['end']).toBe((x['address'] as number) + (x['count'] as number) * ((x['format'] as { width: number }).width));
    }
  });

  it('filters by count and address window, and includes non-maximal runs on request', async () => {
    const { deps, binId } = await opened();
    const withAll = payload<AxisPage>(await call(listDetectedAxesTool, { binId, maximalOnly: false, limit: 500 }, deps));
    const maximal = payload<AxisPage>(await call(listDetectedAxesTool, { binId, limit: 500 }, deps));
    expect(withAll.total).toBeGreaterThanOrEqual(maximal.total);
    const big = payload<AxisPage>(await call(listDetectedAxesTool, { binId, minCount: 8, limit: 500 }, deps));
    expect(big.axes.every((x) => (x['count'] as number) >= 8)).toBe(true);
    const win = payload<AxisPage>(await call(listDetectedAxesTool, { binId, addressMin: 0, addressMax: 1024, limit: 500 }, deps));
    expect(win.axes.every((x) => (x['address'] as number) < 1024)).toBe(true);
  });

  it('rejects an unknown bin and an over-cap limit', async () => {
    const { deps, binId } = await opened();
    expect(errorText(await call(listDetectedAxesTool, { binId: 'nope' }, deps))).toContain('open_bin');
    expect(errorText(await call(listDetectedAxesTool, { binId, limit: 501 }, deps))).toContain('between 1 and 500');
  });
});
