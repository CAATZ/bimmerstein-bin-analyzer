import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MapDef, Result } from '@binanalyzer/core';
import { LiveSessionStore } from '../src/live-session.js';
import type { CoPilotLink } from '../src/link/server.js';
import type { SessionState } from '../src/link/envelope.js';
import { FakeFileIo } from './helpers.js';
// This file has its own local fakeLink (op-only callback); the shared one takes
// (op, args), which dirtyLink needs. Aliased so both stay usable side by side.
import {
  EDITED_BYTES, EDITED_SHA, LIVE_BYTES, LIVE_SHA, dirtyLink,
  fakeLink as sharedFakeLink, liveBins, liveState,
} from './link-fakes.js';

const BYTES = Uint8Array.from({ length: 256 }, (_, i) => (i * 7) & 0xff);
const SHA = createHash('sha256').update(BYTES).digest('hex');

const VIEW = {
  format: { width: 1 as const, signed: false, endianness: 'little' as const },
  columns: 16, origin: 0, valueRange: null, viewMode: 'hex' as const, previewOpen: false,
};

function stateWith(path: string | null): SessionState {
  return {
    bin: { sha256: SHA, name: 'live.bin', size: BYTES.length, path, working: null },
    maps: [], axisLibrary: [], addressFrame: 'none', selection: null,
    viewParams: VIEW, scanStatus: { state: 'idle' },
  };
}

function fakeLink(
  state: SessionState | null,
  onRequest?: (op: string) => Result<unknown>
): CoPilotLink & { ops: string[] } {
  const ops: string[] = [];
  return {
    ops,
    connected: () => state !== null,
    state: () => state,
    async request(op: string): Promise<Result<never>> {
      ops.push(op);
      return (onRequest?.(op) ?? { ok: false, error: `unhandled op ${op}` }) as Result<never>;
    },
    onDisconnect() {},
    onDecision() {},
    async close() {},
  };
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describe('LiveSessionStore', () => {
  it('has no entry when nothing is connected', async () => {
    const s = new LiveSessionStore(fakeLink(null), new FakeFileIo());
    expect(await s.list()).toEqual([]);
    expect(await s.get(SHA)).toBeUndefined();
    expect(await s.evictedPath(SHA)).toBeUndefined();
  });

  it('reads the bytes from binPath when the sha matches', async () => {
    const link = fakeLink(stateWith('C:/bins/live.bin'));
    const s = new LiveSessionStore(link, new FakeFileIo({ 'C:/bins/live.bin': BYTES }));
    const e = await s.get(SHA);
    expect(e?.sha256).toBe(SHA);
    expect(e?.bytes).toEqual(BYTES);
    expect(link.ops).toEqual([]); // no byte request was needed
  });

  it('falls back to the link when the file on disk does not match', async () => {
    const wrong = Uint8Array.from({ length: 256 }, () => 1);
    const link = fakeLink(stateWith('C:/bins/live.bin'), () => ({ ok: true, value: { base64: b64(BYTES) } }));
    const s = new LiveSessionStore(link, new FakeFileIo({ 'C:/bins/live.bin': wrong }));
    expect((await s.get(SHA))?.bytes).toEqual(BYTES);
    expect(link.ops).toEqual(['getBinBytes']);
  });

  it('falls back to the link when there is no path at all', async () => {
    const link = fakeLink(stateWith(null), () => ({ ok: true, value: { base64: b64(BYTES) } }));
    const s = new LiveSessionStore(link, new FakeFileIo());
    expect((await s.get(SHA))?.bytes).toEqual(BYTES);
    expect(link.ops).toEqual(['getBinBytes']);
  });

  it('refuses bytes from the link whose sha does not match', async () => {
    const link = fakeLink(stateWith(null), () => ({ ok: true, value: { base64: b64(Uint8Array.of(1, 2, 3)) } }));
    const s = new LiveSessionStore(link, new FakeFileIo());
    await expect(s.get(SHA)).rejects.toThrow(/sha256/i);
  });

  it('reports the app\'s error when the bytes cannot be obtained at all', async () => {
    const link = fakeLink(stateWith(null), () => ({ ok: false, error: 'no bin is open in the app' }));
    const s = new LiveSessionStore(link, new FakeFileIo());
    await expect(s.get(SHA)).rejects.toThrow(/no bin is open/);
  });

  it('resolves bytes once and caches them by sha', async () => {
    const link = fakeLink(stateWith(null), () => ({ ok: true, value: { base64: b64(BYTES) } }));
    const s = new LiveSessionStore(link, new FakeFileIo());
    await s.get(SHA);
    await s.get(SHA);
    expect(link.ops).toEqual(['getBinBytes']); // not twice
  });

  it('exposes the app-confirmed maps and one entry in list()', async () => {
    const state = stateWith('C:/bins/live.bin');
    const confirmed: MapDef = {
      id: 'm1', name: 'Dwell', address: 16, rows: 1, cols: 4,
      format: { width: 1, signed: false, endianness: 'little' },
      scaling: { factor: 1, offset: 0, units: 'ms', digits: 2 },
      orientation: 'row-major', provenance: 'imported',
    };
    state.maps = [confirmed];
    const s = new LiveSessionStore(fakeLink(state), new FakeFileIo({ 'C:/bins/live.bin': BYTES }));
    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.confirmed?.map((m) => m.id)).toEqual(['m1']);
  });

  it('keeps its own scan and axis cache across gets', async () => {
    const s = new LiveSessionStore(fakeLink(stateWith('C:/bins/live.bin')), new FakeFileIo({ 'C:/bins/live.bin': BYTES }));
    await s.setScan(SHA, { configVersion: 'v1', result: { regions: [], potentialMaps: [] }, durationMs: 5 });
    await s.setDetectedAxes(SHA, []);
    const e = await s.get(SHA);
    expect(e?.scan?.durationMs).toBe(5);
    expect(e?.detectedAxes).toEqual([]);
  });

  it('drops its caches when the app opens a different bin', async () => {
    const state = stateWith('C:/bins/live.bin');
    const s = new LiveSessionStore(fakeLink(state), new FakeFileIo({ 'C:/bins/live.bin': BYTES }));
    await s.setScan(SHA, { configVersion: 'v1', result: { regions: [], potentialMaps: [] }, durationMs: 5 });
    state.bin = { ...state.bin!, sha256: 'b'.repeat(64) };
    expect(await s.get(SHA)).toBeUndefined();
  });

  it('open() is not reachable in co-pilot mode and says so', async () => {
    const s = new LiveSessionStore(fakeLink(null), new FakeFileIo());
    await expect(
      s.open({ binId: SHA, sha256: SHA, name: 'x', path: 'x', size: 1, isFullRead: false, bytes: BYTES, originalBytes: BYTES, contentSha256: SHA, changedBytes: 0 })
    ).rejects.toThrow(/user opens bins/i);
  });
});

describe('dirty sessions resolve the working buffer', () => {
  it('takes the disk fast path only while clean', async () => {
    const store = new LiveSessionStore(sharedFakeLink(liveState()), new FakeFileIo(liveBins()));
    const entry = await store.get(LIVE_SHA);
    expect(entry!.bytes).toBe(entry!.originalBytes);
    expect(entry!.contentSha256).toBe(LIVE_SHA);
    expect(entry!.changedBytes).toBe(0);
  });

  it('fetches working bytes over the link when the journal is non-empty', async () => {
    const store = new LiveSessionStore(dirtyLink(), new FakeFileIo(liveBins()));
    const entry = await store.get(LIVE_SHA);

    expect(entry!.binId).toBe(LIVE_SHA);            // identity is stable
    expect(entry!.contentSha256).toBe(EDITED_SHA);  // content is not
    expect(entry!.changedBytes).toBe(1);
    expect(entry!.bytes[0]).toBe(EDITED_BYTES[0]);
    expect(entry!.originalBytes[0]).toBe(LIVE_BYTES[0]);
  });

  it('refuses working bytes whose hash is not the one the app declared', async () => {
    const state = liveState();
    state.bin!.working = { sha256: EDITED_SHA, changedBytes: 1 };
    const liar = sharedFakeLink(state, () => ({
      ok: true,
      value: { base64: Buffer.from(LIVE_BYTES).toString('base64'), sha256: LIVE_SHA, which: 'working' },
    }));
    const store = new LiveSessionStore(liar, new FakeFileIo(liveBins()));
    await expect(store.get(LIVE_SHA)).rejects.toThrow(/refusing to analyse/);
  });
});
