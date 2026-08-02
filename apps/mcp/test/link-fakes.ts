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

export function liveState(over: Partial<SessionState> = {}): SessionState {
  return {
    bin: { sha256: LIVE_SHA, name: 'live.bin', size: LIVE_BYTES.length, path: LIVE_PATH },
    maps: [], axisLibrary: [], addressFrame: 'none', selection: null,
    viewParams: VIEW, scanStatus: { state: 'idle' },
    ...over,
  };
}
