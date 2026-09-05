import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(new URL('../bin/bimmerstein-mcp.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../../fixtures/synthetic/synth-1.bin', import.meta.url));

/** Newline-delimited JSON-RPC over stdio — the MCP stdio framing. */
class Client {
  private buffer = '';
  private readonly pending = new Map<number, (msg: Record<string, unknown>) => void>();
  readonly stderr: string[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line.length > 0) {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg['id'];
          if (typeof id === 'number') this.pending.get(id)?.(msg);
        }
        nl = this.buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  request(id: number, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${this.stderr.join('')}`)), 40_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}

const child = spawn(process.execPath, [LAUNCHER], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
const client = new Client(child);

afterAll(() => {
  child.kill();
});

function toolPayload(response: Record<string, unknown>): Record<string, unknown> {
  const result = response['result'] as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  if (result?.isError === true) throw new Error(`tool errored: ${result.content?.[0]?.text ?? ''}`);
  return JSON.parse(result?.content?.[0]?.text ?? 'null') as Record<string, unknown>;
}

describe('stdio server (real launcher, real JSON-RPC)', () => {
  let binId = '';

  it('initializes and advertises all 11 tools', async () => {
    const init = await client.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'plan-test', version: '0' },
    });
    const result = init['result'] as { serverInfo?: { name?: string }; instructions?: string };
    expect(result.serverInfo?.name).toBe('bimmerstein-bin-analyzer');
    expect(result.instructions).toContain('UNTRUSTED DATA');
    client.notify('notifications/initialized');

    const list = await client.request(2, 'tools/list');
    const tools = (list['result'] as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'export_definition', 'get_map', 'import_definition', 'list_bins', 'list_detected_axes',
      'list_maps', 'open_bin', 'read_bytes', 'read_map', 'scan_bin', 'verify_checksums',
    ]);
  });

  it('opens a bin and reads bytes over the wire', async () => {
    const opened = toolPayload(await client.request(3, 'tools/call', { name: 'open_bin', arguments: { path: FIXTURE } }));
    binId = String(opened['binId']);
    expect(binId).toMatch(/^[0-9a-f]{64}$/);
    expect(opened['size']).toBe(131072);

    const bytes = toolPayload(await client.request(4, 'tools/call', { name: 'read_bytes', arguments: { binId, address: 0, length: 16 } }));
    expect((bytes['hex'] as unknown[]).length).toBe(1);
  });

  it('scans IN A WORKER and matches the in-process engine result', async () => {
    // This is the regression guard for the raw-TS loader handoff into
    // worker_threads: a vitest parent runs under vite-node, not tsx, so only a
    // spawn through the real launcher exercises it.
    const scan = toolPayload(await client.request(5, 'tools/call', { name: 'scan_bin', arguments: { binId } }));
    expect(scan['potentialMapCount']).toBe(23);
    expect((scan['regions'] as unknown[]).length).toBe(7);
    expect(scan['cached']).toBe(false);

    const cached = toolPayload(await client.request(6, 'tools/call', { name: 'scan_bin', arguments: { binId } }));
    expect(cached['cached']).toBe(true);

    const page = toolPayload(await client.request(7, 'tools/call', { name: 'list_maps', arguments: { binId, limit: 5 } }));
    expect(page['total']).toBe(23);
    expect((page['maps'] as unknown[]).length).toBe(5);
  });

  it('reports a tool error as isError rather than killing the transport', async () => {
    const bad = await client.request(8, 'tools/call', { name: 'get_map', arguments: { binId, mapId: 'nope' } });
    expect((bad['result'] as { isError?: boolean }).isError).toBe(true);
    const after = await client.request(9, 'tools/call', { name: 'list_bins', arguments: {} });
    expect(((after['result'] as { content: Array<{ text: string }> }).content[0]?.text ?? '').length).toBeGreaterThan(2);
  });
});
