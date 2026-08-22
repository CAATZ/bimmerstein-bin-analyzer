import { describe, expect, it } from 'vitest';
import { RequestTable } from '../src/requests.js';

describe('RequestTable', () => {
  it('mints distinct ids and starts pending', () => {
    const t = new RequestTable();
    const a = t.create('proposal', 306);
    const b = t.create('save');
    expect(a.requestId).not.toBe(b.requestId);
    expect(a).toMatchObject({ kind: 'proposal', status: 'pending', count: 306 });
    expect(b).toMatchObject({ kind: 'save', status: 'pending' });
    expect(b.count).toBeUndefined();
  });

  it('returns undefined for an unknown id', () => {
    expect(new RequestTable().get('nope')).toBeUndefined();
  });

  it('settles once and ignores a second settle', () => {
    const t = new RequestTable();
    const r = t.create('proposal', 2);
    t.settle(r.requestId, { status: 'accepted', acceptedIds: ['c1'], rejectedIds: ['c2'] });
    t.settle(r.requestId, { status: 'rejected' });
    expect(t.get(r.requestId)).toMatchObject({ status: 'accepted', acceptedIds: ['c1'], rejectedIds: ['c2'] });
  });

  it('settling an unknown id is a no-op, not a throw', () => {
    const t = new RequestTable();
    expect(() => t.settle('nope', { status: 'accepted' })).not.toThrow();
  });

  it('cancelAll settles only what is still pending', () => {
    const t = new RequestTable();
    const done = t.create('proposal', 1);
    const open = t.create('proposal', 1);
    t.settle(done.requestId, { status: 'accepted', acceptedIds: [], rejectedIds: [] });
    t.cancelAll('the co-pilot link disconnected');
    expect(t.get(done.requestId)?.status).toBe('accepted');
    expect(t.get(open.requestId)).toMatchObject({
      status: 'cancelled', reason: 'the co-pilot link disconnected',
    });
  });

  it('bounds how many it remembers, dropping the oldest', () => {
    const t = new RequestTable(3);
    const first = t.create('proposal', 1);
    t.create('proposal', 1);
    t.create('proposal', 1);
    t.create('proposal', 1);
    expect(t.get(first.requestId)).toBeUndefined();
  });
});

describe('a settled request surfaces rows that failed to apply', () => {
  it('records failed[] so get_request can hand it back', () => {
    // The agent needs the reason a row it proposed did not land. A row that
    // is in neither acceptedIds nor rejectedIds tells it nothing.
    const t = new RequestTable();
    const r = t.create('map-edits', 2);
    t.settle(r.requestId, {
      status: 'accepted',
      acceptedIds: ['fresh'],
      rejectedIds: [],
      failed: [{ id: 'stale', error: 'expected raw 8, found 50' }],
    });
    const row = t.get(r.requestId)!;
    expect(row.acceptedIds).toEqual(['fresh']);
    expect(row.failed).toEqual([{ id: 'stale', error: 'expected raw 8, found 50' }]);
  });
});
