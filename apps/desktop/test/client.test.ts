import { describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { ScanClient, type ScanCallbacks, type WorkerLike } from '../src/worker/client.js';
import type { ScanRequest, WorkerToClient } from '../src/worker/protocol.js';

class FakeWorker implements WorkerLike {
  posted: ScanRequest[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(message: unknown): void {
    this.posted.push(message as ScanRequest);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(msg: WorkerToClient): void {
    this.onmessage?.({ data: msg });
  }
}

function recorder(): { cb: ScanCallbacks; events: string[] } {
  const events: string[] = [];
  return {
    events,
    cb: {
      onProgress: (stage, fraction) => events.push(`progress:${stage}:${fraction}`),
      onResult: (r) => events.push(`result:${r.potentialMaps.length}`),
      onError: (m) => events.push(`error:${m}`),
      onCanceled: () => events.push('canceled'),
    },
  };
}

const BYTES = new Uint8Array([1, 2, 3]);
const A_MAP = { id: 'auto-1' } as MapDef;

describe('ScanClient', () => {
  it('spawns lazily, posts the request, forwards progress then result, then goes idle', () => {
    const workers: FakeWorker[] = [];
    const client = new ScanClient(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    expect(workers).toHaveLength(0);
    const { cb, events } = recorder();
    client.start(BYTES, undefined, cb);
    expect(workers).toHaveLength(1);
    expect(client.running).toBe(true);
    const req = workers[0]!.posted[0]!;
    expect(req.bytes).toBe(BYTES);
    expect(req.config).toBeUndefined();
    workers[0]!.emit({ id: req.id, kind: 'progress', stage: 'tables', fraction: 0.45 });
    workers[0]!.emit({ id: req.id, kind: 'result', regions: [], potentialMaps: [A_MAP] });
    expect(events).toEqual(['progress:tables:0.45', 'result:1']);
    expect(client.running).toBe(false);
  });

  it('cancel terminates the worker, reports canceled, and a new start respawns', () => {
    const workers: FakeWorker[] = [];
    const client = new ScanClient(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    const { cb, events } = recorder();
    client.start(BYTES, undefined, cb);
    client.cancel();
    expect(workers[0]!.terminated).toBe(true);
    expect(events).toEqual(['canceled']);
    expect(client.running).toBe(false);
    // messages from the dead worker are stale and must be dropped
    workers[0]!.emit({ id: 1, kind: 'result', regions: [], potentialMaps: [] });
    expect(events).toEqual(['canceled']);
    const second = recorder();
    client.start(BYTES, undefined, second.cb);
    expect(workers).toHaveLength(2);
    const req2 = workers[1]!.posted[0]!;
    workers[1]!.emit({ id: req2.id, kind: 'result', regions: [], potentialMaps: [] });
    expect(second.events).toEqual(['result:0']);
  });

  it('starting while running cancels the previous scan first', () => {
    const workers: FakeWorker[] = [];
    const client = new ScanClient(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    const first = recorder();
    client.start(BYTES, undefined, first.cb);
    const second = recorder();
    client.start(BYTES, undefined, second.cb);
    expect(first.events).toEqual(['canceled']);
    expect(workers).toHaveLength(2);
    expect(client.running).toBe(true);
    const req2 = workers[1]!.posted[0]!;
    workers[1]!.emit({ id: req2.id, kind: 'error', message: 'boom' });
    expect(second.events).toEqual(['error:boom']);
    expect(client.running).toBe(false);
  });

  it('cancel when idle is a no-op', () => {
    const client = new ScanClient(() => new FakeWorker());
    expect(() => client.cancel()).not.toThrow();
    expect(client.running).toBe(false);
  });
});
