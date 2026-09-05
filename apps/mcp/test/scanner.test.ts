import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { scan } from '@binanalyzer/engine';
import { InlineScanner, serializeScans, WorkerScanner } from '../src/scanner.js';

const FIXTURE = new URL('../../../fixtures/synthetic/synth-1.bin', import.meta.url);

describe('InlineScanner', () => {
  it('returns exactly what the engine returns', async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const direct = scan(bytes);
    const viaScanner = await new InlineScanner().scan(bytes);
    expect(viaScanner.potentialMaps.length).toBe(direct.potentialMaps.length);
    expect(viaScanner.regions.length).toBe(direct.regions.length);
    expect(viaScanner.potentialMaps.length).toBe(23);
    expect(viaScanner.regions.length).toBe(7);
  });

  it('dispose is a no-op that resolves', async () => {
    await expect(new InlineScanner().dispose()).resolves.toBeUndefined();
  });
});

describe('WorkerScanner', () => {
  // The worker bootstraps its OWN TypeScript loader (scan-worker-boot.mjs), so
  // it does not depend on the parent thread having one. That is what makes
  // this testable here at all: a vitest parent runs under vite-node, not tsx.
  // The earlier execArgv-handoff design passed on Node 24 and failed on the
  // Node 22 CI runner — this test is the regression guard for that.
  it('scans in a real worker thread and matches the in-process engine', async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const scanner = new WorkerScanner();
    try {
      const res = await scanner.scan(bytes);
      expect(res.potentialMaps.length).toBe(23);
      expect(res.regions.length).toBe(7);
    } finally {
      await scanner.dispose();
    }
  });

  it("does not detach the caller's buffer", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const scanner = new WorkerScanner();
    try {
      await scanner.scan(bytes);
      // A transfer of the session's own buffer would zero its length here and
      // break every later read_map on that bin.
      expect(bytes.byteLength).toBe(131072);
      expect(bytes[0]).toBeTypeOf('number');
    } finally {
      await scanner.dispose();
    }
  });
});

describe('serializeScans', () => {
  it('runs queued work one at a time, in order', async () => {
    const running: number[] = [];
    let peak = 0;
    let live = 0;
    const run = serializeScans();
    const job = (id: number) => async (): Promise<number> => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      running.push(id);
      live--;
      return id;
    };
    const results = await Promise.all([run(job(1)), run(job(2)), run(job(3))]);
    expect(results).toEqual([1, 2, 3]);
    expect(running).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it('a rejection does not wedge the queue', async () => {
    const run = serializeScans();
    await expect(run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(run(async () => 'fine')).resolves.toBe('fine');
  });
});
