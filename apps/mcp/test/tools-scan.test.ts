import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ScanResult } from '@binanalyzer/engine';
import { call, errorText, fakeDeps, payload } from './helpers.js';
import { openBinTool, scanBinTool } from '../src/tools/index.js';
import type { Scanner } from '../src/scanner.js';

const SYNTH1 = new Uint8Array(readFileSync(new URL('../../../fixtures/synthetic/synth-1.bin', import.meta.url)));

class CountingScanner implements Scanner {
  calls = 0;
  constructor(private readonly inner: Scanner) {}
  async scan(bytes: Uint8Array): Promise<ScanResult> {
    this.calls++;
    return this.inner.scan(bytes);
  }
  async dispose(): Promise<void> {
    await this.inner.dispose();
  }
}

describe('scan_bin', () => {
  it('returns a summary and never the map list', async () => {
    const deps = fakeDeps({ bins: { '/b/s1.bin': SYNTH1 } });
    const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/s1.bin' }, deps));
    const r = payload(await call(scanBinTool, { binId }, deps));
    expect(r).not.toHaveProperty('maps');
    expect(r).not.toHaveProperty('potentialMaps');
    expect(r['potentialMapCount']).toBe(24);
    expect((r['regions'] as unknown[]).length).toBe(7);
    expect(r['cached']).toBe(false);
    const byKind = r['byKind'] as Record<string, number>;
    expect(byKind['grid']! + byKind['curve']! + byKind['switch']! + byKind['param']!).toBe(24);
    const byDetector = r['byDetector'] as Record<string, number>;
    expect(Object.values(byDetector).reduce((s, n) => s + n, 0)).toBe(24);
    const summary = r['regionSummary'] as Record<string, { count: number; bytes: number }>;
    expect(Object.values(summary).reduce((s, v) => s + v.bytes, 0)).toBe(SYNTH1.length);
  });

  it('serves the cache on the second call and re-runs under force', async () => {
    const inner = fakeDeps().scanner;
    const scanner = new CountingScanner(inner);
    const deps = fakeDeps({ bins: { '/b/s1.bin': SYNTH1 }, scanner });
    const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/s1.bin' }, deps));
    await call(scanBinTool, { binId }, deps);
    const second = payload(await call(scanBinTool, { binId }, deps));
    expect(second['cached']).toBe(true);
    expect(second['durationMs']).toBe(0);
    expect(scanner.calls).toBe(1);
    const forced = payload(await call(scanBinTool, { binId, force: true }, deps));
    expect(forced['cached']).toBe(false);
    expect(scanner.calls).toBe(2);
  });

  it('errors on an unknown binId and says how to recover', async () => {
    expect(errorText(await call(scanBinTool, { binId: 'deadbeef' }, fakeDeps()))).toContain('open_bin');
  });

  it('surfaces a scanner failure without throwing', async () => {
    const failing: Scanner = {
      async scan(): Promise<ScanResult> { throw new Error('worker exploded'); },
      async dispose(): Promise<void> { /* nothing */ },
    };
    const deps = fakeDeps({ bins: { '/b/s1.bin': SYNTH1 }, scanner: failing });
    const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/s1.bin' }, deps));
    expect(errorText(await call(scanBinTool, { binId }, deps))).toContain('worker exploded');
  });
});
