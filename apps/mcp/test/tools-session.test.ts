import { describe, expect, it } from 'vitest';
import { getSessionTool } from '../src/tools/get-session.js';
import { errorText, fakeDeps, payload } from './helpers.js';
import { LIVE_SHA, fakeLink, liveBins, liveState } from './link-fakes.js';

describe('get_session', () => {
  it('errors in headless mode and names the flag', async () => {
    expect(errorText(await getSessionTool.handle({}, fakeDeps()))).toContain('--copilot');
  });

  it('errors when the app is not connected and names the toggle', async () => {
    const deps = fakeDeps({ link: fakeLink(null) });
    expect(errorText(await getSessionTool.handle({}, deps))).toContain('Share session with co-pilot');
  });

  it('reports the live session', async () => {
    const deps = fakeDeps({
      link: fakeLink(liveState({ addressFrame: 'ms41full', selection: { start: 4520, end: 4552, cols: 8 }, scanStatus: { state: 'done' } })),
      bins: liveBins(),
    });
    const p = payload(await getSessionTool.handle({}, deps));
    expect(p).toMatchObject({
      connected: true,
      binId: LIVE_SHA,
      bin: { name: 'live.bin', size: 262144, isFullRead: true, hasPath: true },
      confirmedMaps: 0,
      axisLibraryEntries: 0,
      addressFrame: 'ms41full',
      scanStatus: { state: 'done' },
    });
    expect(p['selection']).toMatchObject({ start: 4520, end: 4552 });
    expect(p['coPilotScan']).toEqual({ scanned: false });
  });

  it('returns bin:null when the app has nothing open', async () => {
    const deps = fakeDeps({ link: fakeLink(liveState({ bin: null })) });
    const p = payload(await getSessionTool.handle({}, deps));
    expect(p).toMatchObject({ connected: true, bin: null });
    expect(p['confirmedMaps']).toBeUndefined();
  });

  it("reports the co-pilot's own scan when it has run", async () => {
    const deps = fakeDeps({
      link: fakeLink(liveState()),
      bins: liveBins(),
    });
    await deps.store.setScan(LIVE_SHA, {
      configVersion: 'v1', durationMs: 4800,
      result: { regions: [], potentialMaps: [{} as never, {} as never] },
    });
    const p = payload(await getSessionTool.handle({}, deps));
    expect(p['coPilotScan']).toEqual({ scanned: true, potentialMaps: 2 });
  });

  it('says so when the app is connected but has not pushed a session yet', async () => {
    const link = fakeLink(liveState());
    // connected() is true but state() has nothing — the window between open and
    // the first state frame.
    const deps = fakeDeps({ link: { ...link, state: () => null } });
    expect(errorText(await getSessionTool.handle({}, deps))).toMatch(/has not sent its session/);
  });
});
