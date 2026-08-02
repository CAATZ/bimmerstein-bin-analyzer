import { describe, expect, it } from 'vitest';
import { getRequestTool, proposeChangesTool } from '../src/tools/propose.js';
import { saveProjectTool } from '../src/tools/save-project.js';
import { RequestTable } from '../src/requests.js';
import { errorText, fakeDeps, payload } from './helpers.js';
import { fakeLink, liveBins, liveState } from './link-fakes.js';

const CHANGES = [
  { id: 'c1', mapId: 'm1', name: 'Dwell' },
  { id: 'c2', mapId: 'm2', name: 'Spark' },
];

function deps(answer?: Parameters<typeof fakeLink>[1]) {
  const requests = new RequestTable();
  const link = fakeLink(liveState(), answer);
  return { ...fakeDeps({ link, requests, bins: liveBins() }), link, requests };
}

describe('propose_changes', () => {
  it('returns a pending requestId immediately and does not block', async () => {
    const d = deps();
    const p = payload(await proposeChangesTool.handle({ title: 'Name the ignition tables', changes: CHANGES }, d));
    expect(p).toMatchObject({ status: 'pending', count: 2 });
    expect(typeof p['requestId']).toBe('string');
    expect(d.link.sent[0]!.op).toBe('propose');
  });

  it('passes the title, reason and requestId to the app', async () => {
    const d = deps();
    const p = payload(await proposeChangesTool.handle({ title: 'T', reason: 'because', changes: CHANGES }, d));
    expect(d.link.sent[0]!.args).toMatchObject({ title: 'T', reason: 'because', requestId: p['requestId'], changes: CHANGES });
  });

  it('requires a title and a non-empty change list with unique ids', async () => {
    const d = deps();
    expect(errorText(await proposeChangesTool.handle({ changes: CHANGES }, d))).toContain('title');
    expect(errorText(await proposeChangesTool.handle({ title: 'T', changes: [] }, d))).toContain('at least one');
    expect(errorText(await proposeChangesTool.handle({ title: 'T', changes: [{ id: 'c1' }, { id: 'c1' }] }, d)))
      .toContain('unique');
    expect(errorText(await proposeChangesTool.handle({ title: 'T', changes: [{ mapId: 'm1' }] }, d))).toContain('id');
  });

  it('refuses a batch past the guard', async () => {
    const d = deps();
    const many = Array.from({ length: 2001 }, (_, i) => ({ id: `c${i}`, mapId: 'm', name: 'x' }));
    expect(errorText(await proposeChangesTool.handle({ title: 'T', changes: many }, d))).toContain('2000');
  });

  it('cancels its own row when the app refuses the proposal', async () => {
    const d = deps(() => ({ ok: false, error: 'no bin is open in the app' }));
    expect(errorText(await proposeChangesTool.handle({ title: 'T', changes: CHANGES }, d)))
      .toBe('no bin is open in the app');
    expect(d.requests.get('r1')).toMatchObject({ status: 'cancelled' });
  });
});

describe('get_request', () => {
  it('reports pending, then the settled outcome', async () => {
    const d = deps();
    const id = String(payload(await proposeChangesTool.handle({ title: 'T', changes: CHANGES }, d))['requestId']);
    expect(payload(await getRequestTool.handle({ requestId: id }, d))).toMatchObject({ status: 'pending' });

    d.requests.settle(id, { status: 'accepted', acceptedIds: ['c1'], rejectedIds: ['c2'], failed: [] });
    expect(payload(await getRequestTool.handle({ requestId: id }, d))).toMatchObject({
      status: 'accepted', acceptedIds: ['c1'], rejectedIds: ['c2'],
    });
  });

  it('names an unknown requestId', async () => {
    expect(errorText(await getRequestTool.handle({ requestId: 'r999' }, deps()))).toContain('r999');
  });

  it('reports cancellation after a disconnect', async () => {
    const d = deps();
    const id = String(payload(await proposeChangesTool.handle({ title: 'T', changes: CHANGES }, d))['requestId']);
    d.requests.cancelAll('the co-pilot link disconnected');
    expect(payload(await getRequestTool.handle({ requestId: id }, d))).toMatchObject({
      status: 'cancelled', reason: 'the co-pilot link disconnected',
    });
  });
});

describe('save_project', () => {
  it('asks the app to run its own Save and returns a pending requestId', async () => {
    const d = deps();
    const p = payload(await saveProjectTool.handle({}, d));
    expect(p).toMatchObject({ status: 'pending' });
    expect(d.link.sent[0]!.op).toBe('save_project');
    expect(d.link.sent[0]!.args).toMatchObject({ requestId: p['requestId'] });
  });

  it('errors in headless mode', async () => {
    expect(errorText(await saveProjectTool.handle({}, fakeDeps()))).toContain('--copilot');
  });
});
