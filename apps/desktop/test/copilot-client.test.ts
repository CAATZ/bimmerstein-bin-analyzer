import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { BACKOFF_MS, CoPilotClient, type ClientDeps, type SocketLike } from '../src/copilot/client.js';
import { coPilotStatus } from '../src/store/stores.js';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; this.onclose?.(); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(o: unknown): void { this.onmessage?.({ data: JSON.stringify(o) }); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s)); }
}

function harness(
  link: { port: number; token: string } | null = { port: 51733, token: 'tok' },
  saveOutcome = true
) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const saves: number[] = [];
  const deps: ClientDeps = {
    connect: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    readLink: async () => link,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    cancel: () => {},
    saveProject: async () => { saves.push(1); return saveOutcome; },
  };
  return {
    deps, sockets, timers, saves,
    fire: () => { const t = timers.shift(); t?.fn(); },
    /** Run every queued 0 ms push callback. */
    flushPushes: () => {
      for (const t of timers.splice(0).filter((x) => x.ms === 0)) t.fn();
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  a.resetStores();
  a.setBin(createBinImage(Uint8Array.from({ length: 256 }, (_, i) => i & 0xff), 'live.bin'));
  coPilotStatus.set('off');
});

describe('CoPilotClient', () => {
  it('dials the port and token from the handshake file', async () => {
    const h = harness();
    new CoPilotClient(h.deps).start();
    await tick();
    expect(h.sockets[0]!.url).toBe('ws://127.0.0.1:51733/?token=tok');
    expect(get(coPilotStatus)).toBe('waiting');
  });

  it('retries when there is no handshake file yet', async () => {
    const h = harness(null);
    new CoPilotClient(h.deps).start();
    await tick();
    expect(h.sockets).toHaveLength(0);
    expect(h.timers[0]!.ms).toBe(BACKOFF_MS[0]);
  });

  it('pushes a full state as soon as it opens, and reports connected', async () => {
    const h = harness();
    new CoPilotClient(h.deps).start();
    await tick();
    h.sockets[0]!.open();
    const first = h.sockets[0]!.frames()[0]!;
    expect(first).toMatchObject({ type: 'state', seq: 1 });
    expect((first['payload'] as Record<string, unknown>)['bin']).toMatchObject({ name: 'live.bin' });
    expect(get(coPilotStatus)).toBe('connected');
  });

  it('answers a request by dispatching it', async () => {
    const h = harness();
    new CoPilotClient(h.deps).start();
    await tick();
    const s = h.sockets[0]!;
    s.open();
    s.deliver({ v: 1, type: 'request', id: 'q1', op: 'show', args: { viewMode: '2d' } });
    await tick();
    expect(s.frames().find((f) => f['type'] === 'response')).toMatchObject({ id: 'q1', ok: true });
  });

  it('answers an unknown op with ok:false instead of going silent', async () => {
    const h = harness();
    new CoPilotClient(h.deps).start();
    await tick();
    const s = h.sockets[0]!;
    s.open();
    s.deliver({ v: 1, type: 'request', id: 'q2', op: 'nope', args: {} });
    await tick();
    expect(s.frames().find((f) => f['id'] === 'q2')).toMatchObject({ ok: false });
  });

  it('drops a version-mismatched frame without replying', async () => {
    const h = harness();
    new CoPilotClient(h.deps).start();
    await tick();
    const s = h.sockets[0]!;
    s.open();
    const before = s.sent.length;
    s.deliver({ v: 99, type: 'request', id: 'q3', op: 'show', args: {} });
    await tick();
    expect(s.sent.length).toBe(before);
  });

  it('coalesces a burst of pushes into one', async () => {
    const h = harness();
    const c = new CoPilotClient(h.deps);
    c.start();
    await tick();
    const s = h.sockets[0]!;
    s.open();
    h.timers.length = 0;
    c.pushState();
    c.pushState();
    c.pushState();
    h.flushPushes();
    const seqs = s.frames().filter((f) => f['type'] === 'state').map((f) => f['seq']);
    expect(seqs).toEqual([1, 2]); // the open push, then ONE coalesced push
  });

  it('runs the app Save flow for save_project and reports it with a decision', async () => {
    const h = harness();
    new CoPilotClient(h.deps).start();
    await tick();
    const s = h.sockets[0]!;
    s.open();
    s.deliver({ v: 1, type: 'request', id: 'q4', op: 'save_project', args: { requestId: 'r7' } });
    await tick();
    await tick();
    expect(h.saves).toHaveLength(1);
    expect(s.frames().find((f) => f['id'] === 'q4')).toMatchObject({ type: 'response', ok: true });
    expect(s.frames().find((f) => f['type'] === 'decision')).toMatchObject({ id: 'r7', accepted: ['r7'] });
  });

  it('reports a CANCELLED save as rejected — the agent must not be told it saved', async () => {
    const h = harness({ port: 51733, token: 'tok' }, false);
    new CoPilotClient(h.deps).start();
    await tick();
    const s = h.sockets[0]!;
    s.open();
    s.deliver({ v: 1, type: 'request', id: 'q5', op: 'save_project', args: { requestId: 'r8' } });
    await tick();
    await tick();
    expect(h.saves).toHaveLength(1);
    expect(s.frames().find((f) => f['type'] === 'decision')).toMatchObject({
      id: 'r8', accepted: [], rejected: ['r8'],
    });
  });

  it('reconnects with backoff after a close, and reports disconnected', async () => {
    const h = harness();
    new CoPilotClient(h.deps).start();
    await tick();
    h.sockets[0]!.open();
    h.timers.length = 0;
    h.sockets[0]!.close();
    expect(get(coPilotStatus)).toBe('disconnected');
    expect(h.timers.at(-1)!.ms).toBe(BACKOFF_MS[0]);
    h.fire();
    await tick();
    expect(h.sockets).toHaveLength(2);
  });

  it('backoff is the measured shape', () => {
    expect(BACKOFF_MS).toEqual([250, 500, 1000, 2000, 4000]);
  });

  it('stop() closes the socket and goes off', async () => {
    const h = harness();
    const c = new CoPilotClient(h.deps);
    c.start();
    await tick();
    h.sockets[0]!.open();
    c.stop();
    expect(h.sockets[0]!.closed).toBe(true);
    expect(get(coPilotStatus)).toBe('off');
  });
});
