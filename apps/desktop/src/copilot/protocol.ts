import type { AxisLibEntry, MapDef, Result } from '@binanalyzer/core';
import type { AddressFrame, ScanState, Selection, ViewParams } from '../store/stores.js';

/**
 * Must equal apps/mcp/src/link/envelope.ts PROTOCOL_VERSION. A mismatch is a
 * hard error. 2 (Part C §3.3): `bin.working` added; see that file for why an
 * additive field still forces a bump.
 */
export const PROTOCOL_VERSION = 2;

/** Fingerprint of the WORKING buffer; null while it is unedited. */
export interface WireWorking {
  sha256: string;
  changedBytes: number;
}

/** Authored state only — everything the co-pilot cannot re-derive. */
export interface SessionState {
  bin: {
    sha256: string;
    name: string;
    size: number;
    path: string | null;
    working: WireWorking | null;
  } | null;
  maps: MapDef[];
  axisLibrary: AxisLibEntry[];
  addressFrame: AddressFrame;
  selection: Selection | null;
  viewParams: ViewParams;
  scanStatus: ScanState;
}

export interface ServerRequest {
  v: number;
  type: 'request';
  id: string;
  op: string;
  args: unknown;
}

export type ServerFrame = ServerRequest | { v: number; type: 'hello'; server: string; protocol: number };

export type ClientFrame =
  | { v: number; type: 'state'; seq: number; payload: SessionState }
  | { v: number; type: 'response'; id: string; ok: true; value?: unknown }
  | { v: number; type: 'response'; id: string; ok: false; error: string }
  | { v: number; type: 'decision'; id: string; accepted: string[]; rejected: string[] };

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** Frames come from another local process: validate, never trust, never throw. */
export function decodeServerFrame(text: string): Result<ServerFrame> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'co-pilot frame is not valid JSON' };
  }
  if (!isObject(raw)) return { ok: false, error: 'co-pilot frame is not a JSON object' };
  if (raw['v'] !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `co-pilot protocol version mismatch: app speaks ${PROTOCOL_VERSION}, frame claims ${String(raw['v'])}`,
    };
  }
  if (raw['type'] === 'hello') return { ok: true, value: raw as unknown as ServerFrame };
  if (raw['type'] === 'request') {
    if (typeof raw['id'] !== 'string' || raw['id'] === '') return { ok: false, error: 'request frame needs an id' };
    if (typeof raw['op'] !== 'string' || raw['op'] === '') return { ok: false, error: 'request frame needs an op' };
    return { ok: true, value: raw as unknown as ServerRequest };
  }
  return { ok: false, error: `unknown co-pilot frame type "${String(raw['type'])}"` };
}
