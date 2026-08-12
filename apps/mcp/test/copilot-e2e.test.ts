import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/link/envelope.js';

const LAUNCHER = fileURLToPath(new URL('../bin/bimmerstein-mcp.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../../fixtures/synthetic/synth-1.bin', import.meta.url));
const handshakeDir = mkdtempSync(join(tmpdir(), 'bs-e2e-'));
const HANDSHAKE = join(handshakeDir, 'copilot-link.json');

let proc: ChildProcessWithoutNullStreams;
let ws: WebSocket;
let rpcSeq = 0;
let stdoutBuffer = '';
const pendingRpc = new Map<number, (v: Record<string, unknown>) => void>();

function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = ++rpcSeq;
  return new Promise((resolve) => {
    pendingRpc.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const toolText = (r: Record<string, unknown>): string =>
  String((r['content'] as Array<{ text: string }>)[0]!.text);

const callTool = async (name: string, args: unknown): Promise<Record<string, unknown>> =>
  JSON.parse(toolText(await rpc('tools/call', { name, arguments: args })));

beforeAll(async () => {
  proc = spawn(process.execPath, [LAUNCHER, '--copilot'], {
    env: { ...process.env, BIMMERSTEIN_LINK_FILE: HANDSHAKE },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // One reader for the whole session — a per-call listener races with framing.
  proc.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += String(chunk);
    let nl = stdoutBuffer.indexOf('\n');
    while (nl >= 0) {
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (line !== '') {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof msg.id === 'number') {
          const resolve = pendingRpc.get(msg.id);
          pendingRpc.delete(msg.id);
          resolve?.((msg.result ?? msg.error) as Record<string, unknown>);
        }
      }
      nl = stdoutBuffer.indexOf('\n');
    }
  });

  await rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' },
  });

  // Poll for the handshake file, then dial it exactly as the app would.
  let rec: { port: number; token: string } | undefined;
  for (let i = 0; i < 100 && rec === undefined; i++) {
    try {
      rec = JSON.parse(readFileSync(HANDSHAKE, 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  expect(rec).toBeDefined();

  const bytes = readFileSync(FIXTURE);
  ws = new WebSocket(`ws://127.0.0.1:${rec!.port}/?token=${rec!.token}`);
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type !== 'request') return;
    if (m.op === 'getBinBytes') {
      ws.send(JSON.stringify({
        v: PROTOCOL_VERSION, type: 'response', id: m.id, ok: true, value: { base64: bytes.toString('base64') },
      }));
      return;
    }
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'response', id: m.id, ok: true, value: { applied: { op: m.op } } }));
  });
  await new Promise((r) => ws.once('open', r));

  ws.send(JSON.stringify({
    v: PROTOCOL_VERSION, type: 'state', seq: 1,
    payload: {
      bin: { sha256: createHash('sha256').update(bytes).digest('hex'), name: 'synth-1.bin', size: bytes.length, path: null, working: null },
      maps: [], axisLibrary: [], addressFrame: 'none', selection: null,
      viewParams: {
        format: { width: 1, signed: false, endianness: 'little' },
        columns: 16, origin: 0, valueRange: null, viewMode: 'hex', previewOpen: false,
      },
      scanStatus: { state: 'idle' },
    },
  }));
  await new Promise((r) => setTimeout(r, 100));
}, 60_000);

afterAll(() => {
  ws?.close();
  proc?.kill();
});

describe('co-pilot mode, end to end through the real launcher', () => {
  it('tools/list withholds open_bin and offers the session tools', async () => {
    const r = await rpc('tools/list', {});
    const names = (r['tools'] as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('get_session');
    expect(names).toContain('propose_changes');
    expect(names).toContain('save_project');
    expect(names).not.toContain('open_bin');
    expect(names).not.toContain('list_bins');
  });

  it('get_session reports the bin the "app" pushed, with no path', async () => {
    const p = await callTool('get_session', {});
    expect(p['connected']).toBe(true);
    expect((p['bin'] as Record<string, unknown>)['name']).toBe('synth-1.bin');
    expect((p['bin'] as Record<string, unknown>)['hasPath']).toBe(false);
  });

  it('scans the bytes it fetched over the link', async () => {
    const session = await callTool('get_session', {});
    const p = await callTool('scan_bin', { binId: session['binId'] });
    expect(p['potentialMapCount']).toBeGreaterThan(0);
  }, 60_000);

  it('a Point op reaches the app', async () => {
    const p = await callTool('select', { address: 16, length: 32 });
    expect(p).toMatchObject({ ok: true, applied: { op: 'select' } });
  });

  it('a proposal returns pending and is pollable', async () => {
    const p = await callTool('propose_changes', {
      title: 'T', changes: [{ id: 'c1', mapId: 'm1', name: 'x' }],
    });
    expect(p['status']).toBe('pending');
    const q = await callTool('get_request', { requestId: p['requestId'] });
    expect(q['status']).toBe('pending');
  });
});
