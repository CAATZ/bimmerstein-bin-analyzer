import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { scan } from '@binanalyzer/engine';
import { InlineScanner, serializeScans } from '../src/scanner.js';

const FIXTURE = new URL('../../../fixtures/synthetic/synth-1.bin', import.meta.url);

describe('InlineScanner', () => {
  it('returns exactly what the engine returns', async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const direct = scan(bytes);
    const viaScanner = await new InlineScanner().scan(bytes);
    expect(viaScanner.potentialMaps.length).toBe(direct.potentialMaps.length);
    expect(viaScanner.regions.length).toBe(direct.regions.length);
    expect(viaScanner.potentialMaps.length).toBe(24);
    expect(viaScanner.regions.length).toBe(7);
  });

  it('dispose is a no-op that resolves', async () => {
    await expect(new InlineScanner().dispose()).resolves.toBeUndefined();
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
