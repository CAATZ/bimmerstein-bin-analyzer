import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBinImage } from '@binanalyzer/core';
import * as actions from '../src/store/actions.js';
import { scanStatus } from '../src/store/stores.js';
import type { WorkerToClient } from '../src/worker/protocol.js';
import { cancelScan, runScan } from '../src/worker/controller.js';
import { closeBinFlow, loadBinFromPath } from '../src/platform/flows.js';
import type { PlatformHost } from '../src/platform/host.js';

/**
 * Minimal WorkerLike stand-in installed as the GLOBAL `Worker` so controller.ts's
 * real `new Worker(new URL(...))` factory constructs one of these instead of a
 * real DOM/Node worker (there is no global Worker under the Vitest node
 * environment). Args are ignored; nothing here depends on the worker script.
 * `Worker` is looked up by controller.ts's factory only when it actually runs
 * (lazily, on the first start()), so stubbing it in beforeEach — before the
 * module-level `runScan`/`cancelScan` below are ever called — is sufficient;
 * no dynamic import/vi.resetModules dance needed.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(msg: WorkerToClient): void {
    this.onmessage?.({ data: msg });
  }
}

vi.stubGlobal('Worker', FakeWorker);

beforeEach(() => {
  FakeWorker.instances.length = 0;
  actions.resetStores();
  actions.setBin(createBinImage(new Uint8Array(8), 'test.bin'));
});

afterEach(() => {
  cancelScan(); // don't leak a "running" client singleton into the next test
});

describe('runScan / cancelScan (worker/controller) — D5 canceled-blip', () => {
  it.each(['close', 'replace'] as const)('%s cancels the old worker only after confirmation', async (action) => {
    const confirm = vi.fn().mockResolvedValue(false);
    const host = { confirm, readBinary: async () => new Uint8Array(8) } as unknown as PlatformHost;
    const change = () => action === 'close' ? closeBinFlow(host) : loadBinFromPath(host, 'next.bin');
    runScan();
    const worker = FakeWorker.instances[0]!;
    expect(await change()).toBe(false);
    expect(worker.terminated).toBe(false);
    confirm.mockResolvedValue(true);
    expect(await change()).toBe(true);
    expect(worker.terminated).toBe(true);
    const request = worker.posted[0] as { id: number };
    worker.emit({ id: request.id, kind: 'progress', stage: 'regions', fraction: 0.5 });
    expect(get(scanStatus)).toEqual({ state: 'idle' });
  });

  it('a scan superseding another (e.g. drag-drop mid-scan) never rests on "canceled"', () => {
    runScan();
    expect(get(scanStatus)).toEqual({ state: 'running', stage: 'regions', fraction: 0 });
    expect(FakeWorker.instances).toHaveLength(1);
    runScan(); // a second scan starts while the first is still in flight
    expect(get(scanStatus)).toEqual({ state: 'running', stage: 'regions', fraction: 0 });
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0]!.terminated).toBe(true); // the superseded scan's worker is gone
  });

  it('explicit cancelScan() still reports "canceled" (Toolbar Cancel button, unaffected)', () => {
    runScan();
    cancelScan();
    expect(get(scanStatus)).toEqual({ state: 'canceled' });
  });

  it('a normal (non-superseding) scan still reaches "running"', () => {
    runScan();
    expect(get(scanStatus)).toEqual({ state: 'running', stage: 'regions', fraction: 0 });
  });
});
