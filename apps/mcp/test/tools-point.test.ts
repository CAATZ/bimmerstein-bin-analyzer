import { describe, expect, it } from 'vitest';
import { openMapTool, selectTool, showTool } from '../src/tools/point.js';
import { errorText, fakeDeps, payload } from './helpers.js';
import { fakeLink, liveBins, liveState } from './link-fakes.js';

const deps = (answer?: Parameters<typeof fakeLink>[1]) => {
  const link = fakeLink(liveState(), answer);
  return { ...fakeDeps({ link, bins: liveBins() }), link };
};

describe('select', () => {
  it('forwards a byte range and reports what the app applied', async () => {
    const d = deps(() => ({ ok: true, value: { applied: { start: 16, end: 48, cols: 8 } } }));
    const p = payload(await selectTool.handle({ address: '0x10', length: 32, cols: 8 }, d));
    expect(d.link.sent).toEqual([{ op: 'select', args: { address: 16, length: 32, cols: 8 } }]);
    expect(p).toEqual({ ok: true, applied: { start: 16, end: 48, cols: 8 } });
  });

  it('forwards a mapId instead', async () => {
    const d = deps(() => ({ ok: true, value: { applied: { start: 16, end: 48 }, resolvedBy: 'address' } }));
    const p = payload(await selectTool.handle({ mapId: 'm1' }, d));
    expect(d.link.sent[0]!.args).toEqual({ mapId: 'm1' });
    expect(p['resolvedBy']).toBe('address');
  });

  it('refuses both forms at once, and neither', async () => {
    expect(errorText(await selectTool.handle({ mapId: 'm1', address: 16 }, deps()))).toContain('exactly one of');
    expect(errorText(await selectTool.handle({}, deps()))).toContain('exactly one of');
  });

  it('surfaces an app-side rejection verbatim', async () => {
    const d = deps(() => ({ ok: false, error: 'no bin is open in the app' }));
    expect(errorText(await selectTool.handle({ address: 16, length: 4 }, d))).toBe('no bin is open in the app');
  });

  it('errors in headless mode without reaching any link', async () => {
    expect(errorText(await selectTool.handle({ address: 0, length: 4 }, fakeDeps()))).toContain('--copilot');
  });
});

describe('show', () => {
  it('forwards an address and a view mode', async () => {
    const d = deps(() => ({ ok: true, value: { applied: { origin: 4096, viewMode: '3d' } } }));
    await showTool.handle({ address: 4096, viewMode: '3d' }, d);
    expect(d.link.sent).toEqual([{ op: 'show', args: { address: 4096, viewMode: '3d' } }]);
  });

  it('rejects an unknown view mode', async () => {
    expect(errorText(await showTool.handle({ viewMode: 'wireframe' }, deps()))).toContain('viewMode');
  });

  it('needs at least one of address or viewMode', async () => {
    expect(errorText(await showTool.handle({}, deps()))).toContain('at least one');
  });
});

describe('open_map', () => {
  it('requires a mapId and forwards it', async () => {
    const d = deps(() => ({ ok: true, value: { applied: { mapId: 'm1', viewMode: '3d' } } }));
    await openMapTool.handle({ mapId: 'm1' }, d);
    expect(d.link.sent).toEqual([{ op: 'open_map', args: { mapId: 'm1' } }]);
    expect(errorText(await openMapTool.handle({}, deps()))).toContain('mapId');
  });
});
