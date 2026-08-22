import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, decodeEnvelope } from '../src/link/envelope.js';

const state = {
  bin: { sha256: 'a'.repeat(64), name: 'x.bin', size: 256, path: 'C:/x.bin', working: null },
  maps: [], axisLibrary: [], addressFrame: 'none',
  selection: null,
  viewParams: {
    format: { width: 1, signed: false, endianness: 'little' },
    columns: 16, origin: 0, valueRange: null, viewMode: 'hex', previewOpen: false,
  },
  scanStatus: { state: 'idle' },
};

describe('decodeEnvelope', () => {
  it('accepts a state message', () => {
    const r = decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'state', seq: 1, payload: state }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.type).toBe('state');
  });

  it('accepts ok and error responses', () => {
    const okR = decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'response', id: 'q1', ok: true, value: { applied: true } }));
    expect(okR.ok).toBe(true);
    const errR = decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'response', id: 'q1', ok: false, error: 'no bin loaded' }));
    expect(errR.ok).toBe(true);
    if (errR.ok && errR.value.type === 'response') expect(errR.value.ok).toBe(false);
  });

  it('accepts a decision message', () => {
    const r = decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'decision', id: 'r1', accepted: ['c1'], rejected: ['c2'] }));
    expect(r.ok).toBe(true);
  });

  it('rejects a protocol-version mismatch by name', () => {
    const r = decodeEnvelope(JSON.stringify({ v: 99, type: 'state', seq: 1, payload: state }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('protocol version');
  });

  it('rejects malformed JSON, non-objects and unknown types', () => {
    expect(decodeEnvelope('not json').ok).toBe(false);
    expect(decodeEnvelope('[]').ok).toBe(false);
    expect(decodeEnvelope('null').ok).toBe(false);
    expect(decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'nope' })).ok).toBe(false);
  });

  it('rejects a state without a numeric seq or an object payload', () => {
    expect(decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'state', payload: state })).ok).toBe(false);
    expect(decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'state', seq: 'x', payload: state })).ok).toBe(false);
    expect(decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'state', seq: 1, payload: 7 })).ok).toBe(false);
  });

  it('rejects a response with no id, and a decision with non-string-array fields', () => {
    expect(decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'response', ok: true })).ok).toBe(false);
    expect(decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'decision', id: 'r1', accepted: 'c1', rejected: [] })).ok).toBe(false);
    expect(decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'decision', id: 'r1', accepted: [1], rejected: [] })).ok).toBe(false);
  });
});

describe('protocol version 2', () => {
  it('is 2 and a version-1 state frame is a hard error', () => {
    // Additive field, but the dangerous skew is a NEW server against an OLD
    // app: it would see no `working`, assume clean, and serve the file as
    // opened as if it were current. Refusing to connect is the safe answer.
    expect(PROTOCOL_VERSION).toBe(2);
    const decoded = decodeEnvelope(JSON.stringify({ v: 1, type: 'state', seq: 1, payload: {} }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error).toContain('protocol version mismatch');
  });
});

describe('a state frame must declare its working buffer', () => {
  it('drops a bin that omits "working" rather than assuming clean', () => {
    // Assuming clean is the stale-bytes hazard the version bump prevents.
    const payload = { ...state, bin: { sha256: 'a'.repeat(64), name: 'x.bin', size: 256, path: null } };
    const r = decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'state', seq: 1, payload }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('working');
  });

  it('accepts bin:null, which has no buffer to describe', () => {
    const payload = { ...state, bin: null };
    expect(decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'state', seq: 1, payload })).ok).toBe(true);
  });
});

describe('a decision may carry rows that failed to apply', () => {
  it('preserves failed[] through decode', () => {
    const r = decodeEnvelope(JSON.stringify({
      v: PROTOCOL_VERSION, type: 'decision', id: 'r1',
      accepted: ['fresh'], rejected: [],
      failed: [{ id: 'stale', error: 'the byte moved since this was proposed' }],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.type !== 'decision') return;
    expect(r.value.failed).toEqual([{ id: 'stale', error: 'the byte moved since this was proposed' }]);
  });

  it('still accepts a decision with no failed[] — save_project has no rows', () => {
    const r = decodeEnvelope(JSON.stringify({
      v: PROTOCOL_VERSION, type: 'decision', id: 'r2', accepted: ['r2'], rejected: [],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.type !== 'decision') return;
    expect(r.value.failed).toBeUndefined();
  });
});
