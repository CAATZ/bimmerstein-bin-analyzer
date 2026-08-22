import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/copilot/protocol.js';
import { linkFilePathFor, makeReadLink } from '../src/copilot/link-file.js';
import type { PlatformHost } from '../src/platform/host.js';

function host(text: string | null): PlatformHost {
  return { async readTextIfExists() { return text; } } as unknown as PlatformHost;
}

const at = (): string => '/link.json';

describe('linkFilePathFor', () => {
  it("matches the server's per-OS resolution", () => {
    // Windows resolves to a SINGLE separator style (see the dedicated block
    // below): these previously asserted forward slashes, which localDataDir()
    // never produces, so the real mixed-separator path went untested.
    expect(linkFilePathFor('windows', { localAppData: 'C:/U/x/AppData/Local', home: 'C:/U/x' }))
      .toBe('C:\\U\\x\\AppData\\Local\\BimmerStein Bin Analyzer\\copilot-link.json');
    expect(linkFilePathFor('windows', { home: 'C:/U/x' }))
      .toBe('C:\\U\\x\\AppData\\Local\\BimmerStein Bin Analyzer\\copilot-link.json');
    expect(linkFilePathFor('macos', { home: '/Users/x' }))
      .toBe('/Users/x/Library/Application Support/BimmerStein Bin Analyzer/copilot-link.json');
    expect(linkFilePathFor('linux', { home: '/home/x' }))
      .toBe('/home/x/.local/state/bimmerstein-bin-analyzer/copilot-link.json');
    expect(linkFilePathFor('linux', { home: '/home/x', xdgStateHome: '/run/state' }))
      .toBe('/run/state/bimmerstein-bin-analyzer/copilot-link.json');
  });
});

describe('makeReadLink', () => {
  it('parses a valid record', async () => {
    const read = makeReadLink(host(JSON.stringify({ v: PROTOCOL_VERSION, port: 51733, token: 'f'.repeat(64) })), at);
    expect(await read()).toEqual({ port: 51733, token: 'f'.repeat(64) });
  });

  it('returns null when the file is absent, malformed, or the wrong version', async () => {
    expect(await makeReadLink(host(null), at)()).toBeNull();
    expect(await makeReadLink(host('{'), at)()).toBeNull();
    expect(await makeReadLink(host(JSON.stringify({ v: 99, port: 1, token: 't' })), at)()).toBeNull();
    expect(await makeReadLink(host(JSON.stringify({ v: PROTOCOL_VERSION, token: 't' })), at)()).toBeNull();
    expect(await makeReadLink(host(JSON.stringify({ v: PROTOCOL_VERSION, port: 1 })), at)()).toBeNull();
  });

  it('never throws when the host itself fails', async () => {
    const angry = { async readTextIfExists() { throw new Error('denied'); } } as unknown as PlatformHost;
    expect(await makeReadLink(angry, at)()).toBeNull();
  });
});

describe('linkFilePathFor on a REAL Windows base', () => {
  it('emits a single separator style, matching the server path.join', () => {
    // localDataDir() returns BACKSLASHES on Windows. Appending forward-slash
    // segments produced a mixed path that the fs plugin does not resolve, so
    // exists() was false, readTextIfExists returned null, and the client never
    // dialled - the link silently never came up.
    const p = linkFilePathFor('windows', {
      localAppData: 'C:\\U\\x\\AppData\\Local',
      home: 'C:\\U\\x',
    });
    expect(p).toBe('C:\\U\\x\\AppData\\Local\\BimmerStein Bin Analyzer\\copilot-link.json');
    expect(p).not.toContain('/');
  });

  it('also normalises the home fallback', () => {
    const p = linkFilePathFor('windows', { home: 'C:\\U\\x' });
    expect(p).toBe('C:\\U\\x\\AppData\\Local\\BimmerStein Bin Analyzer\\copilot-link.json');
    expect(p).not.toContain('/');
  });
});
