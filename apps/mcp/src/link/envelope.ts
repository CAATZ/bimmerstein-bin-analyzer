import type { AxisLibEntry, MapDef, Result, ValueFormat } from '@binanalyzer/core';

/** Bumped only on a breaking wire change; a mismatch is a hard error, never a degrade. */
export const PROTOCOL_VERSION = 1;

export interface WireSelection {
  start: number;
  end: number;
  cols?: number;
  mapId?: string;
}

export interface WireViewParams {
  format: ValueFormat;
  columns: number;
  origin: number;
  valueRange: { min: number; max: number } | null;
  viewMode: 'hex' | '2d' | '3d' | 'map';
  previewOpen: boolean;
}

export type WireScanStatus =
  | { state: 'idle' }
  | { state: 'running'; stage: string; fraction: number }
  | { state: 'done' }
  | { state: 'canceled' }
  | { state: 'error'; message: string };

/**
 * Authored state only — everything the co-pilot cannot re-derive
 * (2026-08-01-mcp-copilot-design.md §5.1). Measured at 197,455 bytes for the
 * realistic ceiling (306 imported maps), so the app resends it whole on every
 * change and there is no diff protocol.
 */
export interface SessionState {
  bin: { sha256: string; name: string; size: number; path: string | null } | null;
  maps: MapDef[];
  axisLibrary: AxisLibEntry[];
  addressFrame: 'none' | 'ms41full';
  selection: WireSelection | null;
  viewParams: WireViewParams;
  scanStatus: WireScanStatus;
}

export type AppMessage =
  | { v: number; type: 'state'; seq: number; payload: SessionState }
  | { v: number; type: 'response'; id: string; ok: true; value?: unknown }
  | { v: number; type: 'response'; id: string; ok: false; error: string }
  | { v: number; type: 'decision'; id: string; accepted: string[]; rejected: string[] };

export type ServerMessage =
  | { v: number; type: 'hello'; server: string; protocol: number }
  | { v: number; type: 'request'; id: string; op: string; args: unknown };

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const isStringArray = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((s) => typeof s === 'string');

/**
 * Frames arrive from another local process; treat every field as hostile input.
 * A decode failure is reported and the frame dropped — it never throws into the
 * socket handler.
 */
export function decodeEnvelope(text: string): Result<AppMessage> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'link frame is not valid JSON' };
  }
  if (!isObject(raw)) return { ok: false, error: 'link frame is not a JSON object' };
  if (raw['v'] !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `link protocol version mismatch: server speaks ${PROTOCOL_VERSION}, frame claims ${String(raw['v'])}`,
    };
  }
  switch (raw['type']) {
    case 'state': {
      if (typeof raw['seq'] !== 'number' || !Number.isFinite(raw['seq'])) {
        return { ok: false, error: 'state frame needs a numeric seq' };
      }
      if (!isObject(raw['payload'])) return { ok: false, error: 'state frame needs an object payload' };
      return { ok: true, value: raw as unknown as Extract<AppMessage, { type: 'state' }> };
    }
    case 'response': {
      if (typeof raw['id'] !== 'string' || raw['id'] === '') return { ok: false, error: 'response frame needs an id' };
      if (raw['ok'] === true) {
        return { ok: true, value: raw as unknown as Extract<AppMessage, { type: 'response'; ok: true }> };
      }
      if (raw['ok'] === false && typeof raw['error'] === 'string') {
        return { ok: true, value: raw as unknown as Extract<AppMessage, { type: 'response'; ok: false }> };
      }
      return { ok: false, error: 'response frame needs ok:true, or ok:false with a string error' };
    }
    case 'decision': {
      if (typeof raw['id'] !== 'string' || raw['id'] === '') return { ok: false, error: 'decision frame needs an id' };
      if (!isStringArray(raw['accepted']) || !isStringArray(raw['rejected'])) {
        return { ok: false, error: 'decision frame needs accepted[] and rejected[] string arrays' };
      }
      return { ok: true, value: raw as unknown as Extract<AppMessage, { type: 'decision' }> };
    }
    default:
      return { ok: false, error: `unknown link frame type "${String(raw['type'])}"` };
  }
}
