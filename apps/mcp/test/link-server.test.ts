import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPLACED_CODE, WsCoPilotLink } from '../src/link/server.js';
import { PROTOCOL_VERSION, type SessionState } from '../src/link/envelope.js';

const handshakeAt = (): string => join(mkdtempSync(join(tmpdir(), 'bslink-')), 'copilot-link.json');

const STATE: SessionState = {
  bin: { sha256: 'a'.repeat(64), name: 'x.bin', size: 256, path: 'C:/x.bin', working: null },
  maps: [], axisLibrary: [], addressFrame: 'none', selection: null,
  viewParams: {
    format: { width: 1, signed: false, endianness: 'little' },
    columns: 16, origin: 0, valueRange: null, viewMode: 'hex', previewOpen: false,
  },
  scanStatus: { state: 'idle' },
};

/**
 * Stand-in for the desktop app. Buffers frames from construction: the server
 * sends `hello` the moment the socket opens, so a listener registered after
 * awaiting 'open' can miss it entirely.
 */
class FakeApp {
  readonly frames: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<(f: Record<string, unknown>) => void> = [];
  readonly ws: WebSocket;
  /** Set to auto-answer every server request. */
  answer: ((m: Record<string, unknown>) => unknown) | null = null;

  constructor(port: number, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    this.ws.on('message', (d) => {
      const frame = JSON.parse(String(d)) as Record<string, unknown>;
      if (frame['type'] === 'request' && this.answer !== null) {
        this.send(this.answer(frame));
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else this.frames.push(frame);
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  /** Next frame, from the buffer if one already arrived. */
  next(): Promise<Record<string, unknown>> {
    const buffered = this.frames.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }

  close(): void {
    this.ws.close();
  }
}

let link: WsCoPilotLink | undefined;
const apps: FakeApp[] = [];

async function attach(l: WsCoPilotLink, token = l.token): Promise<FakeApp> {
  const app = new FakeApp(l.port, token);
  apps.push(app);
  await app.opened();
  return app;
}

afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  await link?.close();
  link = undefined;
});

describe('WsCoPilotLink', () => {
  it('starts disconnected with no state', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    expect(link.connected()).toBe(false);
    expect(link.state()).toBeNull();
    expect(link.token).toMatch(/^[0-9a-f]{64}$/);
    expect(link.port).toBeGreaterThan(0);
  });

  it('rejects a wrong token before the socket opens', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    await expect(attach(link, 'deadbeef')).rejects.toThrow(/401/);
    expect(link.connected()).toBe(false);
  });

  it('greets an authenticated client and ingests its state', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    const app = await attach(link);
    expect((await app.next())['type']).toBe('hello');
    app.send({ v: PROTOCOL_VERSION, type: 'state', seq: 1, payload: STATE });
    await vi.waitFor(() => expect(link!.state()?.bin?.name).toBe('x.bin'));
    expect(link.connected()).toBe(true);
  });

  it('ignores a state whose seq did not advance', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    const app = await attach(link);
    app.send({ v: PROTOCOL_VERSION, type: 'state', seq: 5, payload: STATE });
    await vi.waitFor(() => expect(link!.state()).not.toBeNull());
    app.send({ v: PROTOCOL_VERSION, type: 'state', seq: 4, payload: { ...STATE, bin: { ...STATE.bin!, name: 'stale.bin' } } });
    await new Promise((r) => setTimeout(r, 50));
    expect(link.state()?.bin?.name).toBe('x.bin');
  });

  it('correlates a request with its response', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    const app = await attach(link);
    app.answer = (m) => ({ v: PROTOCOL_VERSION, type: 'response', id: m['id'], ok: true, value: { op: m['op'], args: m['args'] } });
    const r = await link.request<{ op: string }>('select', { address: 16 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.op).toBe('select');
  });

  it('surfaces an app-side rejection as a Result error', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    const app = await attach(link);
    app.answer = (m) => ({ v: PROTOCOL_VERSION, type: 'response', id: m['id'], ok: false, error: 'no confirmed map with id z' });
    const r = await link.request('change_map', { mapId: 'z' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no confirmed map with id z');
  });

  it('fails a request when nothing is connected', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    const r = await link.request('select', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not connected');
  });

  it('survives a large message — the fragmentation case', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    const app = await attach(link);
    const big = { ...STATE, bin: { ...STATE.bin!, name: 'y'.repeat(200_000) } };
    app.send({ v: PROTOCOL_VERSION, type: 'state', seq: 2, payload: big });
    await vi.waitFor(() => expect(link!.state()?.bin?.name.length).toBe(200_000), { timeout: 4000 });
  });

  it('a second client replaces the first, and disconnect fires', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    let drops = 0;
    link.onDisconnect(() => drops++);
    const first = await attach(link);
    const closed = new Promise<number>((r) => first.ws.once('close', (code) => r(code)));
    await attach(link);
    expect(await closed).toBe(REPLACED_CODE);
    expect(link.connected()).toBe(true);
    expect(drops).toBeGreaterThanOrEqual(1);
  });

  it('a disconnect fails everything pending', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    const app = await attach(link);
    const pending = link.request('select', { address: 0 }); // the app never answers
    await new Promise((r) => setTimeout(r, 50));
    app.close();
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('disconnected');
  });

  it('a decision frame reaches the onDecision hook', async () => {
    link = await WsCoPilotLink.listen({ handshakePath: handshakeAt() });
    const seen: Array<[string, string[], string[]]> = [];
    link.onDecision((id, accepted, rejected) => seen.push([id, accepted, rejected]));
    const app = await attach(link);
    app.send({ v: PROTOCOL_VERSION, type: 'decision', id: 'r1', accepted: ['c1'], rejected: ['c2'] });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual(['r1', ['c1'], ['c2']]);
  });

  it('writes the handshake file and removes it on close', async () => {
    const at = handshakeAt();
    link = await WsCoPilotLink.listen({ handshakePath: at });
    const rec = JSON.parse(readFileSync(at, 'utf8'));
    expect(rec.port).toBe(link.port);
    expect(rec.token).toBe(link.token);
    await link.close();
    link = undefined;
    expect(existsSync(at)).toBe(false);
  });
});
