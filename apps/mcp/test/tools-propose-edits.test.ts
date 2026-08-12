import { describe, expect, it } from 'vitest';
import { RequestTable } from '../src/requests.js';
import { proposeMapEditsTool } from '../src/tools/propose-edits.js';
import { errorText, fakeDeps, payload } from './helpers.js';
import { type FakeLink, fakeLink, liveBins, liveState } from './link-fakes.js';

const cell = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'e1', kind: 'cell', mapId: 'm1', row: 0, col: 0, value: 12, expectedRaw: 5, ...over,
});

const deps = (): ReturnType<typeof fakeDeps> & { link: FakeLink } => {
  const link = fakeLink(liveState());
  return fakeDeps({ link, bins: liveBins(), requests: new RequestTable() }) as ReturnType<typeof fakeDeps> & {
    link: FakeLink;
  };
};

describe('propose_map_edits', () => {
  it('queues a batch and returns a pending requestId', async () => {
    const p = payload(await proposeMapEditsTool.handle({ title: 'Richen cruise', edits: [cell()] }, deps()));
    expect(p['status']).toBe('pending');
    expect(p['count']).toBe(1);
    expect(typeof p['requestId']).toBe('string');
  });

  it('requires expectedRaw — an agent must read before it writes', async () => {
    const bad = cell();
    delete bad['expectedRaw'];
    expect(errorText(await proposeMapEditsTool.handle({ title: 't', edits: [bad] }, deps()))).toContain('expectedRaw');
  });

  it('rejects two rows aimed at the same target', async () => {
    // Ambiguous under per-item accept: checking only the second yields a
    // different result from checking both, and the panel cannot render that.
    const r = await proposeMapEditsTool.handle(
      { title: 't', edits: [cell(), cell({ id: 'e2', value: 99 })] },
      deps()
    );
    expect(errorText(r)).toContain('same cell');
  });

  it('rejects duplicate ids', async () => {
    const r = await proposeMapEditsTool.handle({ title: 't', edits: [cell(), cell({ col: 1 })] }, deps());
    expect(errorText(r)).toContain('unique');
  });

  it('requires an axis row to name axis and index', async () => {
    const r = await proposeMapEditsTool.handle(
      { title: 't', edits: [{ id: 'a1', kind: 'axis', mapId: 'm1', value: 3000, expectedRaw: 40 }] },
      deps()
    );
    expect(r.isError).toBe(true);
  });

  it('accepts a well-formed axis row', async () => {
    const r = await proposeMapEditsTool.handle(
      { title: 't', edits: [{ id: 'a1', kind: 'axis', mapId: 'm1', axis: 'x', index: 2, value: 3000, expectedRaw: 40 }] },
      deps()
    );
    expect(r.isError).toBeUndefined();
  });

  it('rejects an unknown kind rather than guessing', async () => {
    const r = await proposeMapEditsTool.handle({ title: 't', edits: [cell({ kind: 'region' })] }, deps());
    expect(errorText(r)).toContain('kind');
  });

  it('sends the rows on the EXISTING propose op', async () => {
    const d = deps();
    await proposeMapEditsTool.handle({ title: 't', edits: [cell()] }, d);
    const last = d.link.sent.at(-1)!;
    expect(last.op).toBe('propose');
    expect((last.args as { changes: unknown[] }).changes).toHaveLength(1);
  });

  it('records the row as a map-edits request, distinct from a metadata proposal', async () => {
    const d = deps();
    const p = payload(await proposeMapEditsTool.handle({ title: 't', edits: [cell()] }, d));
    expect(d.requests!.get(p['requestId'] as string)?.kind).toBe('map-edits');
  });

  it('errors without a link, naming the toggle', async () => {
    const r = await proposeMapEditsTool.handle({ title: 't', edits: [cell()] }, fakeDeps({ link: fakeLink(null) }));
    expect(r.isError).toBe(true);
  });
});
