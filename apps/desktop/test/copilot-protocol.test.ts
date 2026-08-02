import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapDef } from '@binanalyzer/core';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { PROTOCOL_VERSION, decodeServerFrame } from '../src/copilot/protocol.js';
import { buildSessionState } from '../src/copilot/wire-state.js';
import { addressFrame, potentialMaps, scanStatus } from '../src/store/stores.js';

function testBin() {
  return createBinImage(Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff), 'live.bin');
}

function mapAt(id: string, address: number): MapDef {
  return {
    id, name: `M ${id}`, address, rows: 2, cols: 4,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major', provenance: 'imported',
  };
}

describe('decodeServerFrame', () => {
  it('accepts hello and request frames', () => {
    expect(decodeServerFrame(JSON.stringify({ v: 1, type: 'hello', server: 's', protocol: 1 })).ok).toBe(true);
    const r = decodeServerFrame(JSON.stringify({ v: 1, type: 'request', id: 'q1', op: 'select', args: {} }));
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'request') expect(r.value.op).toBe('select');
  });

  it('rejects a version mismatch, malformed JSON, non-objects and unknown types', () => {
    const bad = decodeServerFrame(JSON.stringify({ v: 99, type: 'hello', server: 's', protocol: 99 }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('protocol version');
    expect(decodeServerFrame('{').ok).toBe(false);
    expect(decodeServerFrame('[]').ok).toBe(false);
    expect(decodeServerFrame(JSON.stringify({ v: 1, type: 'zzz' })).ok).toBe(false);
  });

  it('rejects a request with no id or no op', () => {
    expect(decodeServerFrame(JSON.stringify({ v: 1, type: 'request', op: 'select' })).ok).toBe(false);
    expect(decodeServerFrame(JSON.stringify({ v: 1, type: 'request', id: 'q1' })).ok).toBe(false);
  });

  it("PROTOCOL_VERSION matches the server's", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

beforeEach(() => a.resetStores());

describe('buildSessionState', () => {
  it('is null-binned before a bin loads', () => {
    expect(buildSessionState().bin).toBeNull();
  });

  it('carries only authored state', () => {
    a.setBin(testBin());
    a.setBinPath('C:/bins/live.bin');
    a.addImportedMaps([mapAt('m1', 0x100)]);
    potentialMaps.set([mapAt('p1', 0x300)]);
    addressFrame.set('ms41full');
    scanStatus.set({ state: 'done' });
    a.setSelection(0x100, 0x108, 4);

    const s = buildSessionState();
    expect(s.bin).toMatchObject({ name: 'live.bin', size: 4096, path: 'C:/bins/live.bin' });
    expect(s.maps.map((m) => m.id)).toEqual(['m1']);
    expect(s.addressFrame).toBe('ms41full');
    expect(s.scanStatus).toEqual({ state: 'done' });
    expect(s.selection).toMatchObject({ start: 0x100, end: 0x108, cols: 4 });
    // The co-pilot re-derives detections itself — they must never cross the wire.
    expect(Object.keys(s)).not.toContain('potentialMaps');
    expect(Object.keys(s)).not.toContain('regions');
  });

  it('reports a null path when the bin came from somewhere without one', () => {
    a.setBin(testBin());
    expect(buildSessionState().bin?.path).toBeNull();
  });
});
