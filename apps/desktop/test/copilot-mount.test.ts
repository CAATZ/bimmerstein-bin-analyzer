import { beforeEach, describe, expect, it } from 'vitest';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { mountCoPilot } from '../src/copilot/mount.js';
import { coPilotEnabled, coPilotStatus, potentialMaps, regions } from '../src/store/stores.js';
import type { CoPilotClient } from '../src/copilot/client.js';

function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    client: {
      start: () => calls.push('start'),
      stop: () => calls.push('stop'),
      pushState: () => calls.push('push'),
    } as unknown as CoPilotClient,
  };
}

beforeEach(() => {
  a.resetStores();
  coPilotEnabled.set(false);
  coPilotStatus.set('off');
});

describe('mountCoPilot', () => {
  it('does nothing until the user consents', () => {
    const f = fakeClient();
    const m = mountCoPilot(() => f.client);
    a.setBin(createBinImage(Uint8Array.of(1, 2, 3, 4), 'x.bin'));
    expect(f.calls).toEqual([]);
    expect(m.current()).toBeNull();
    m.stop();
  });

  it('starts on consent and stops when it is withdrawn', () => {
    const f = fakeClient();
    const m = mountCoPilot(() => f.client);
    coPilotEnabled.set(true);
    expect(f.calls).toContain('start');
    expect(m.current()).not.toBeNull();
    coPilotEnabled.set(false);
    expect(f.calls).toContain('stop');
    expect(m.current()).toBeNull();
    m.stop();
  });

  it('pushes state when authored state changes', () => {
    const f = fakeClient();
    const m = mountCoPilot(() => f.client);
    coPilotEnabled.set(true);
    f.calls.length = 0;
    a.setSelection(0, 4);
    expect(f.calls).toContain('push');
    m.stop();
  });

  it('does NOT push for detections or regions — the co-pilot re-derives those', () => {
    const f = fakeClient();
    const m = mountCoPilot(() => f.client);
    a.setBin(createBinImage(Uint8Array.from({ length: 256 }, (_, i) => i), 'x.bin'));
    coPilotEnabled.set(true);
    f.calls.length = 0;
    potentialMaps.set([]);
    regions.set([{ start: 0, end: 16, kind: 'data' }]);
    expect(f.calls).not.toContain('push');
    m.stop();
  });

  it('unmounting stops the client', () => {
    const f = fakeClient();
    const m = mountCoPilot(() => f.client);
    coPilotEnabled.set(true);
    f.calls.length = 0;
    m.stop();
    expect(f.calls).toEqual(['stop']);
  });
});
