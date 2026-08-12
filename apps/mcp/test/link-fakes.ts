import { createHash } from 'node:crypto';
import type { Result } from '@binanalyzer/core';
import type { CoPilotLink } from '../src/link/server.js';
import type { SessionState } from '../src/link/envelope.js';

export interface FakeLink extends CoPilotLink {
  sent: Array<{ op: string; args: unknown }>;
}

/** `state === null` models "toggle on, app not connected". */
export function fakeLink(
  state: SessionState | null,
  answer: (op: string, args: unknown) => Result<unknown> = () => ({ ok: true, value: {} })
): FakeLink {
  const sent: Array<{ op: string; args: unknown }> = [];
  return {
    sent,
    connected: () => state !== null,
    state: () => state,
    async request(op: string, args: unknown) {
      sent.push({ op, args });
      return answer(op, args) as Result<never>;
    },
    onDisconnect() {},
    onDecision() {},
    async close() {},
  };
}

export const VIEW = {
  format: { width: 1 as const, signed: false, endianness: 'little' as const },
  columns: 16, origin: 0, valueRange: null, viewMode: 'hex' as const, previewOpen: false,
};

/** A real 256 KB body so LiveSessionStore's sha check passes off FakeFileIo. */
export const LIVE_BYTES = Uint8Array.from({ length: 262144 }, (_, i) => (i * 31) & 0xff);
export const LIVE_SHA = createHash('sha256').update(LIVE_BYTES).digest('hex');
export const LIVE_PATH = 'C:/live.bin';
export const liveBins = (): Record<string, Uint8Array> => ({ [LIVE_PATH]: LIVE_BYTES });

/** LIVE_BYTES with byte 0 flipped: a working buffer that differs from the file. */
export const EDITED_BYTES = (() => {
  const b = LIVE_BYTES.slice();
  b[0] = b[0]! ^ 0xff;
  return b;
})();
export const EDITED_SHA = createHash('sha256').update(EDITED_BYTES).digest('hex');

/**
 * A working buffer that scans to something COMPLETELY different. Detection over
 * this must never be mistaken for detection over LIVE_BYTES, which is what
 * makes the pinned-scan test discriminating rather than vacuous.
 */
export const WIPED_BYTES = new Uint8Array(LIVE_BYTES.length);

/**
 * A live state whose journal is non-empty, plus a link that serves BOTH
 * buffers and hashes whichever it sent — the app's side of Part C §3.4.
 */
export function dirtyLink(changedBytes = 1, workingBytes: Uint8Array = EDITED_BYTES): FakeLink {
  const workingSha = createHash('sha256').update(workingBytes).digest('hex');
  const state = liveState();
  state.bin!.working = { sha256: workingSha, changedBytes };
  return fakeLink(state, (op, args) => {
    if (op !== 'getBinBytes') return { ok: true, value: {} };
    const which = (args as { which?: string }).which === 'original' ? 'original' : 'working';
    const bytes = which === 'original' ? LIVE_BYTES : workingBytes;
    const sha = which === 'original' ? LIVE_SHA : workingSha;
    return { ok: true, value: { base64: Buffer.from(bytes).toString('base64'), sha256: sha, which } };
  });
}

export function liveState(over: Partial<SessionState> = {}): SessionState {
  return {
    bin: { sha256: LIVE_SHA, name: 'live.bin', size: LIVE_BYTES.length, path: LIVE_PATH, working: null },
    maps: [], axisLibrary: [], addressFrame: 'none', selection: null,
    viewParams: VIEW, scanStatus: { state: 'idle' },
    ...over,
  };
}
