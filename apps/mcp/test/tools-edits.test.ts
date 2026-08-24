import { describe, expect, it } from 'vitest';
import { call, errorText, fakeDeps, payload } from './helpers.js';
import { listEditsTool } from '../src/tools/list-edits.js';
import { MCP_CONFIG } from '../src/config.js';
import { LIVE_BYTES, LIVE_SHA, dirtyLink, fakeLink, liveBins, liveState } from './link-fakes.js';

/** LIVE_BYTES with bytes 1,2,3 flipped: three unattributed changes. */
const THREE_EDITS = (() => {
  const b = LIVE_BYTES.slice();
  b[1] = b[1]! ^ 0xff;
  b[2] = b[2]! ^ 0xff;
  b[3] = b[3]! ^ 0xff;
  return b;
})();

const dirty = (): ReturnType<typeof fakeDeps> => fakeDeps({ link: dirtyLink(), bins: liveBins() });
const paged = (): ReturnType<typeof fakeDeps> =>
  fakeDeps({ link: dirtyLink(3, THREE_EDITS), bins: liveBins() });
const clean = (): ReturnType<typeof fakeDeps> =>
  fakeDeps({ link: fakeLink(liveState()), bins: liveBins() });

describe('list_edits', () => {
  it('names the tool and requires binId in its schema', () => {
    expect(listEditsTool.name).toBe('list_edits');
    expect((listEditsTool.inputSchema as { required: string[] }).required).toEqual(['binId']);
  });

  it('rejects a missing binId with a message naming the argument', async () => {
    expect(errorText(await call(listEditsTool, {}, dirty()))).toContain('binId');
  });

  it('reports the one edited byte as a raw row', async () => {
    const p = payload(await call(listEditsTool, { binId: LIVE_SHA }, dirty()));
    expect(p['changedBytes']).toBe(1);
    expect(p['edits']).toEqual([
      { kind: 'raw', offset: 0, original: LIVE_BYTES[0], current: LIVE_BYTES[0]! ^ 0xff },
    ]);
    expect(p).not.toHaveProperty('note');
  });

  it('reports a clean session as empty, with a note rather than an error', async () => {
    const r = await call(listEditsTool, { binId: LIVE_SHA }, clean());
    const p = payload(r);
    expect(r.isError).toBeUndefined();
    expect(p['changedBytes']).toBe(0);
    expect(p['edits']).toEqual([]);
    expect(String(p['note'])).toContain('no edits');
  });

  it('pages with a total order, so pages never overlap or skip', async () => {
    const deps = paged();
    const p1 = payload(await call(listEditsTool, { binId: LIVE_SHA, limit: 2 }, deps));
    const p2 = payload(await call(listEditsTool, { binId: LIVE_SHA, limit: 2, offset: 2 }, deps));

    expect(p1['total']).toBe(3);
    expect(p1['hasMore']).toBe(true);
    expect((p1['edits'] as Array<{ offset: number }>).map((e) => e.offset)).toEqual([1, 2]);
    expect((p2['edits'] as Array<{ offset: number }>).map((e) => e.offset)).toEqual([3]);
    expect(p2['hasMore']).toBe(false);
  });

  it('filters by kind', async () => {
    const deps = paged();
    const cells = payload(await call(listEditsTool, { binId: LIVE_SHA, kind: 'cell' }, deps));
    const raw = payload(await call(listEditsTool, { binId: LIVE_SHA, kind: 'raw' }, deps));

    expect(cells['edits']).toEqual([]);
    expect(cells['total']).toBe(0);
    // changedBytes is the whole-image truth and is NOT narrowed by a filter.
    expect(cells['changedBytes']).toBe(3);
    expect(raw['edits']).toHaveLength(3);
  });

  it('refuses a limit above the configured maximum', async () => {
    const r = await call(
      listEditsTool,
      { binId: LIVE_SHA, limit: MCP_CONFIG.listEditsMaxLimit + 1 },
      paged()
    );
    expect(r.isError).toBe(true);
  });

  it('errors helpfully on an unknown binId', async () => {
    expect(errorText(await call(listEditsTool, { binId: 'deadbeef' }, dirty()))).toContain('deadbeef');
  });
});
