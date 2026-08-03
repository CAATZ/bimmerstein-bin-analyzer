import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONSENT_KEY, persistCoPilotConsent, type ConsentStorage } from '../src/store/consent.js';
import { coPilotEnabled } from '../src/store/stores.js';

function memoryStorage(seed: Record<string, string> = {}): ConsentStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

beforeEach(() => coPilotEnabled.set(false));

describe('persistCoPilotConsent', () => {
  it('leaves consent OFF when nothing was ever stored', () => {
    const stop = persistCoPilotConsent(memoryStorage());
    expect(get(coPilotEnabled)).toBe(false);
    stop();
  });

  it('restores consent the user gave in an earlier session', () => {
    const stop = persistCoPilotConsent(memoryStorage({ [CONSENT_KEY]: 'true' }));
    expect(get(coPilotEnabled)).toBe(true);
    stop();
  });

  // Off by default is the consent gate (spec §4.5): anything that is not the
  // exact stored "true" must read as off, including junk left by another app.
  it('treats any other stored value as off', () => {
    for (const junk of ['false', '1', 'TRUE', '', '{"on":true}']) {
      coPilotEnabled.set(false);
      const stop = persistCoPilotConsent(memoryStorage({ [CONSENT_KEY]: junk }));
      expect(get(coPilotEnabled), junk).toBe(false);
      stop();
    }
  });

  it('writes every change back so the next launch sees it', () => {
    const storage = memoryStorage();
    const stop = persistCoPilotConsent(storage);
    coPilotEnabled.set(true);
    expect(storage.data[CONSENT_KEY]).toBe('true');
    coPilotEnabled.set(false);
    expect(storage.data[CONSENT_KEY]).toBe('false');
    stop();
  });

  it('stops writing once unsubscribed', () => {
    const storage = memoryStorage();
    persistCoPilotConsent(storage)();
    coPilotEnabled.set(true);
    expect(storage.data[CONSENT_KEY]).toBe('false');
  });

  // A webview that refuses storage (private mode, disabled DOM storage) must
  // not take the app down with it — consent simply falls back to off.
  it('never throws when the storage itself is hostile', () => {
    const angry: ConsentStorage = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    };
    const stop = persistCoPilotConsent(angry);
    expect(get(coPilotEnabled)).toBe(false);
    expect(() => coPilotEnabled.set(true)).not.toThrow();
    stop();
  });
});
