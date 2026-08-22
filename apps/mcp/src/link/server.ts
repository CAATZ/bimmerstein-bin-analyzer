import { createServer, type Server as HttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Result } from '@binanalyzer/core';
import { MCP_CONFIG } from '../config.js';
import { PROTOCOL_VERSION, decodeEnvelope, type SessionState } from './envelope.js';
import { mintToken, removeHandshake, writeHandshake } from './handshake.js';

/** Close code for "another window took over the link" — distinguishable from a normal close. */
export const REPLACED_CODE = 4001;

export interface CoPilotLink {
  connected(): boolean;
  /** Latest authored state the app pushed, or null if it has not pushed one. */
  state(): SessionState | null;
  /** Ask the app to do something. Never throws; app-side rejections come back as Result errors. */
  request<T>(op: string, args: unknown): Promise<Result<T>>;
  /** Called whenever a connection is lost, so pending user decisions can be cancelled. */
  onDisconnect(fn: () => void): void;
  /** Called when the app reports a user's decision on a proposal. */
  onDecision(
    fn: (id: string, accepted: string[], rejected: string[], failed: Array<{ id: string; error: string }>) => void
  ): void;
  close(): Promise<void>;
}

interface Pending {
  resolve(r: Result<unknown>): void;
  timer: NodeJS.Timeout;
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class WsCoPilotLink implements CoPilotLink {
  private socket: WebSocket | null = null;
  private latest: SessionState | null = null;
  private lastSeq = -Infinity;
  private readonly pending = new Map<string, Pending>();
  private readonly disconnectHooks: Array<() => void> = [];
  private readonly decisionHooks: Array<
    (id: string, accepted: string[], rejected: string[], failed: Array<{ id: string; error: string }>) => void
  > = [];
  private reqSeq = 0;

  private constructor(
    private readonly http: HttpServer,
    private readonly wss: WebSocketServer,
    readonly port: number,
    readonly token: string,
    private readonly handshakePath: string | undefined
  ) {}

  static async listen(opts: { handshakePath?: string; host?: string } = {}): Promise<WsCoPilotLink> {
    const token = mintToken();
    const http = createServer((_req, res) => {
      res.writeHead(426);
      res.end('upgrade required');
    });
    const wss = new WebSocketServer({ noServer: true });
    // Port 0 = OS-assigned. 127.0.0.1 explicitly: never 0.0.0.0, never ::.
    await new Promise<void>((resolve) => http.listen(0, opts.host ?? '127.0.0.1', resolve));
    const port = (http.address() as AddressInfo).port;
    const link = new WsCoPilotLink(http, wss, port, token, opts.handshakePath);

    http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!tokenMatches(url.searchParams.get('token'), token)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => link.adopt(ws));
    });

    writeHandshake(port, token, opts.handshakePath);
    return link;
  }

  private adopt(ws: WebSocket): void {
    const previous = this.socket;
    // One connection at a time: a second app window replaces the first rather
    // than the two flapping over each other. A replacement IS a disconnect of
    // the previous instance — anything it had pending will never be answered by
    // the person who was looking at it, so fail requests and fire the hooks
    // (which cancel pending user decisions) before the new socket takes over.
    if (previous !== null && previous.readyState === previous.OPEN) {
      this.socket = null;
      previous.close(REPLACED_CODE, 'replaced by a newer co-pilot connection');
      this.failAllPending('replaced by a newer co-pilot connection');
      for (const fn of this.disconnectHooks) fn();
    }
    this.socket = ws;
    this.latest = null; // the new window has not pushed its session yet
    this.lastSeq = -Infinity;

    ws.on('message', (data) => this.ingest(String(data)));
    ws.on('close', () => {
      if (this.socket !== ws) return; // already replaced
      this.socket = null;
      this.latest = null;
      this.failAllPending('the co-pilot link disconnected');
      for (const fn of this.disconnectHooks) fn();
    });
    ws.on('error', () => {
      /* 'close' always follows */
    });

    ws.send(JSON.stringify({
      v: PROTOCOL_VERSION, type: 'hello', server: 'bimmerstein-mcp/0.1.0', protocol: PROTOCOL_VERSION,
    }));
  }

  private ingest(text: string): void {
    const decoded = decodeEnvelope(text);
    if (!decoded.ok) {
      // stdout belongs to the MCP protocol; diagnostics go to stderr.
      process.stderr.write(`co-pilot link: dropped a frame — ${decoded.error}\n`);
      return;
    }
    const msg = decoded.value;
    if (msg.type === 'state') {
      if (msg.seq <= this.lastSeq) return; // stale or replayed
      this.lastSeq = msg.seq;
      this.latest = msg.payload;
      return;
    }
    if (msg.type === 'response') {
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error });
      return;
    }
    // failed[] is optional on the wire; absent means no row failed to apply.
    for (const fn of this.decisionHooks) fn(msg.id, msg.accepted, msg.rejected, msg.failed ?? []);
  }

  private failAllPending(error: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error });
    }
    this.pending.clear();
  }

  connected(): boolean {
    return this.socket !== null && this.socket.readyState === this.socket.OPEN;
  }

  state(): SessionState | null {
    return this.connected() ? this.latest : null;
  }

  async request<T>(op: string, args: unknown): Promise<Result<T>> {
    const ws = this.socket;
    if (ws === null || ws.readyState !== ws.OPEN) {
      return {
        ok: false,
        error: 'the desktop app is not connected — ask the user to enable "Share session with co-pilot"',
      };
    }
    const id = `q${++this.reqSeq}`;
    return new Promise<Result<T>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `the app did not answer "${op}" within ${MCP_CONFIG.linkRequestTimeoutMs} ms` });
      }, MCP_CONFIG.linkRequestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (r: Result<unknown>) => void, timer });
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'request', id, op, args }));
    });
  }

  onDisconnect(fn: () => void): void {
    this.disconnectHooks.push(fn);
  }

  onDecision(
    fn: (id: string, accepted: string[], rejected: string[], failed: Array<{ id: string; error: string }>) => void
  ): void {
    this.decisionHooks.push(fn);
  }

  async close(): Promise<void> {
    this.failAllPending('the co-pilot server is shutting down');
    this.socket?.close();
    this.socket = null;
    removeHandshake(this.handshakePath);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
