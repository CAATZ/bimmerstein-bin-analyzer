import { describe, expect, it } from 'vitest';
import { linkFilePathFor, makeReadLink } from '../src/copilot/link-file.js';
import type { PlatformHost } from '../src/platform/host.js';

function host(text: string | null): PlatformHost {
  return { async readTextIfExists() { return text; } } as unknown as PlatformHost;
}

const at = (): string => '/link.json';

describe('linkFilePathFor', () => {
  it("matches the server's per-OS resolution", () => {
    expect(linkFilePathFor('windows', { localAppData: 'C:/U/x/AppData/Local', home: 'C:/U/x' }))
      .toBe('C:/U/x/AppData/Local/BimmerStein Bin Analyzer/copilot-link.json');
    expect(linkFilePathFor('windows', { home: 'C:/U/x' }))
      .toBe('C:/U/x/AppData/Local/BimmerStein Bin Analyzer/copilot-link.json');
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
    const read = makeReadLink(host(JSON.stringify({ v: 1, port: 51733, token: 'f'.repeat(64) })), at);
    expect(await read()).toEqual({ port: 51733, token: 'f'.repeat(64) });
  });

  it('returns null when the file is absent, malformed, or the wrong version', async () => {
    expect(await makeReadLink(host(null), at)()).toBeNull();
    expect(await makeReadLink(host('{'), at)()).toBeNull();
    expect(await makeReadLink(host(JSON.stringify({ v: 99, port: 1, token: 't' })), at)()).toBeNull();
    expect(await makeReadLink(host(JSON.stringify({ v: 1, token: 't' })), at)()).toBeNull();
    expect(await makeReadLink(host(JSON.stringify({ v: 1, port: 1 })), at)()).toBeNull();
  });

  it('never throws when the host itself fails', async () => {
    const angry = { async readTextIfExists() { throw new Error('denied'); } } as unknown as PlatformHost;
    expect(await makeReadLink(angry, at)()).toBeNull();
  });
});
