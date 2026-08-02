import { describe, expect, it } from 'vitest';
import { changeAxisEntryTool, changeMapTool } from '../src/tools/change.js';
import { errorText, fakeDeps, payload } from './helpers.js';
import { fakeLink, liveBins, liveState } from './link-fakes.js';

const deps = (answer?: Parameters<typeof fakeLink>[1]) => {
  const link = fakeLink(liveState(), answer);
  return { ...fakeDeps({ link, bins: liveBins() }), link };
};

describe('change_map', () => {
  it("forwards a rename and returns the app's updated map", async () => {
    const d = deps(() => ({ ok: true, value: { map: { id: 'm1', name: 'Dwell' } } }));
    const p = payload(await changeMapTool.handle({ mapId: 'm1', name: 'Dwell' }, d));
    expect(d.link.sent).toEqual([{ op: 'change_map', args: { mapId: 'm1', name: 'Dwell' } }]);
    expect(p).toMatchObject({ ok: true, map: { name: 'Dwell' } });
  });

  it('forwards scaling, category, notes, promote and axes', async () => {
    const d = deps();
    await changeMapTool.handle({
      mapId: 'm1', category: 'Ignition', notes: 'from the log',
      scaling: { factor: 0.75, offset: -48, units: 'deg', digits: 2 },
      promote: true, xAxis: null,
    }, d);
    expect(d.link.sent[0]!.args).toEqual({
      mapId: 'm1', category: 'Ignition', notes: 'from the log',
      scaling: { factor: 0.75, offset: -48, units: 'deg', digits: 2 },
      promote: true, xAxis: null,
    });
  });

  it('requires a mapId', async () => {
    expect(errorText(await changeMapTool.handle({ name: 'x' }, deps()))).toContain('mapId');
  });

  it('refuses a call that changes nothing', async () => {
    expect(errorText(await changeMapTool.handle({ mapId: 'm1' }, deps()))).toContain('at least one');
  });

  it("surfaces the app's own validation message", async () => {
    const d = deps(() => ({ ok: false, error: 'no confirmed map with id m9' }));
    expect(errorText(await changeMapTool.handle({ mapId: 'm9', name: 'x' }, d))).toBe('no confirmed map with id m9');
  });

  it('tells a bulk caller to use propose_changes', async () => {
    const r = await changeMapTool.handle({ mapId: ['m1', 'm2'], name: 'x' }, deps());
    expect(errorText(r)).toContain('propose_changes');
  });

  it('errors in headless mode', async () => {
    expect(errorText(await changeMapTool.handle({ mapId: 'm1', name: 'x' }, fakeDeps()))).toContain('--copilot');
  });
});

describe('change_axis_entry', () => {
  it('creates an entry', async () => {
    const d = deps(() => ({ ok: true, value: { entry: { id: 'e1', name: 'RPM' } } }));
    const p = payload(await changeAxisEntryTool.handle({
      create: {
        name: 'RPM',
        axis: { kind: 'referenced', address: 2048, count: 16, format: { width: 2, signed: false, endianness: 'big' } },
      },
    }, d));
    expect(d.link.sent[0]!.op).toBe('change_axis_entry');
    expect(p).toMatchObject({ ok: true, entry: { name: 'RPM' } });
  });

  it('edits, restamps and removes by entryId', async () => {
    const d = deps();
    await changeAxisEntryTool.handle({ entryId: 'e1', name: 'RPM 16' }, d);
    await changeAxisEntryTool.handle({ entryId: 'e1', restamp: true }, d);
    await changeAxisEntryTool.handle({ entryId: 'e1', remove: true }, d);
    expect(d.link.sent.map((s) => s.args)).toEqual([
      { entryId: 'e1', name: 'RPM 16' },
      { entryId: 'e1', restamp: true },
      { entryId: 'e1', remove: true },
    ]);
  });

  it('needs exactly one of create or entryId', async () => {
    const d = deps();
    expect(errorText(await changeAxisEntryTool.handle({}, d))).toContain('exactly one of');
    expect(errorText(await changeAxisEntryTool.handle({ entryId: 'e1', create: { name: 'x', axis: {} } }, d)))
      .toContain('exactly one of');
  });

  it('refuses an entryId call that changes nothing', async () => {
    expect(errorText(await changeAxisEntryTool.handle({ entryId: 'e1' }, deps()))).toContain('at least one');
  });
});
