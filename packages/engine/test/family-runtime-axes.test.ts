import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_CONFIG as cfg } from '../src/config.js';
import { resolveMs41CurveAxes } from '../src/family/ms41/runtime-axes.js';
import { scanReaderCalls } from '../src/family/ms41/c166.js';
import { saToFo } from '../src/family/ms41/frame.js';

function fixture() {
  const b = new Uint8Array(0x40000);
  b.set([4, 0, 25, 0, 50, 0, 75, 0, 100, 0], saToFo(0x800));
  b.set([4, 0, 10, 0, 20, 0, 30, 0, 40, 0], saToFo(0x820));
  b.set([0x00, 0x08], saToFo(0x600));
  b.set([0x20, 0x08], saToFo(0x602));
  // Word-axis descriptor reader publishes its interpolation index at E980.
  b.set([0xa8, 0x3c, 0x98, 0x23, 0xf7, 0xf4, 0x80, 0xe9, 0xdb, 0], 0x2000);
  // Table reader uses that index, without reading a descriptor itself.
  b.set([0xc2, 0xf1, 0x80, 0xe9, 0x00, 0x1c, 0xa9, 0x81, 0xdb, 0], 0x2100);
  b.set([0xdb, 0, 0xe6, 0xfc, 0, 6, 0xda, 0, 0, 0x60], 0xfe);
  b.set([0xe6, 0xfc, 0, 9, 0xda, 0, 0, 0x61, 0xdb, 0], 0x108);
  return b;
}
const resolve = (b: Uint8Array) => resolveMs41CurveAxes(b, scanReaderCalls(b, cfg.family.ms41.maxR12Dist), new Map([[0x6100, 1]]), cfg);

describe('MS41 runtime curve axis binding', () => {
  it('retains its staged axis across a second-axis stager and preserving helpers', () => {
    const b = fixture();
    // The intervening stager publishes a different index byte.
    b.set([0xa8, 0x3c, 0x98, 0x23, 0xf7, 0xf4, 0x81, 0xe9, 0xdb, 0], 0x2200);
    b.set([0xf0, 0x4c, 0x0b, 0x45, 0xf2, 0xf4, 0x0e, 0xfe, 0xdb, 0], 0x2300);
    b.set([0xe6, 0xfc, 2, 6, 0xda, 0, 0, 0x62, 0xda, 0, 0, 0x63,
      0xe6, 0xfc, 0, 9, 0xda, 0, 0, 0x61, 0xdb, 0], 0x108);
    expect(resolve(b).get(0x900)).toMatchObject({ dataSA: 0x802, width: 2, count: 4 });
  });

  it('rejects helpers that may overwrite state, never return or exceed the call bound', () => {
    for (const body of [
      [0x2d, 2, 0xf7, 0xf8, 0x80, 0xe9, 0xdb, 0],
      [0x88, 0x34, 0xdb, 0],
      [0x11, 0, 0xdb, 0],
      [0x0d, 0xff],
      [0xda, 0, 0, 0x63, 0xdb, 0],
    ]) {
      const b = fixture();
      b.set(body, 0x2300);
      b.set([0xda, 0, 0, 0x63, 0xe6, 0xfc, 0, 9, 0xda, 0, 0, 0x61, 0xdb, 0], 0x108);
      expect(resolve(b).has(0x900)).toBe(false);
    }
  });

  it('binds a staged terminal plateau without accepting an all-equal axis', () => {
    const b = fixture();
    b.set([4, 0, 25, 0, 50, 0, 75, 0, 75, 0], saToFo(0x800));
    expect(resolve(b).get(0x900)).toMatchObject({ dataSA: 0x802, width: 2, count: 4, kind: 'plateau' });
    b.set([4, 0, 25, 0, 25, 0, 25, 0, 25, 0], saToFo(0x800));
    expect(resolve(b).has(0x900)).toBe(false);
  });

  it('uses the staged descriptor rather than a stale adjacent table header', () => {
    const b = fixture();
    b.set([0x20, 0x08], saToFo(0x8fe));
    expect(resolve(b).get(0x900)).toMatchObject({ dataSA: 0x802, width: 2, count: 4 });
  });

  it('follows a branch to reused interpolation state without inventing fallthrough', () => {
    const b = fixture();
    b.set([0x8a, 0x15, 3, 0, 0xda, 0, 0, 0x70, 0x0d, 9], 0x108);
    b.set([0xe6, 0xfc, 0, 9, 0xda, 0, 0, 0x61, 0xdb, 0], 0x112);
    expect(resolve(b).get(0x900)?.dataSA).toBe(0x802);
  });

  it('declines conflicting staging paths and an unstaged path', () => {
    const b = fixture();
    b.set([0x8a, 0x15, 4, 0, 0xe6, 0xfc, 2, 6, 0xda, 0, 0, 0x60], 0x108);
    b.set([0xe6, 0xfc, 0, 9, 0xda, 0, 0, 0x61, 0xdb, 0], 0x114);
    expect(resolve(b).has(0x900)).toBe(false);
    b.set([0xdb, 0, 0xcc, 0, 0x0d, 6], 0x100);
    expect(resolve(b).has(0x900)).toBe(false);
  });

  it('declines an intervening state write or unknown helper', () => {
    const b = fixture();
    b.set([0xf7, 0xf4, 0x80, 0xe9, 0xe6, 0xfc, 0, 9, 0xda, 0, 0, 0x61, 0xdb, 0], 0x108);
    expect(resolve(b).has(0x900)).toBe(false);
    b.set([0xda, 0, 0, 0x70], 0x108);
    expect(resolve(b).has(0x900)).toBe(false);
  });

  it('requires matching index storage and a valid axis of the staged width', () => {
    const b = fixture();
    b[0x2006] = 0x81;
    expect(resolve(b).has(0x900)).toBe(false);
    b[0x2006] = 0x80;
    b[saToFo(0x800)] = 0;
    expect(resolve(b).has(0x900)).toBe(false);
  });

  it('requires the published index to come from the descriptor count', () => {
    const b = fixture();
    b.set([0xe0, 0x02, 0xf7, 0xf4, 0x80, 0xe9, 0xdb, 0], 0x2004);
    expect(resolve(b).has(0x900)).toBe(false);
  });

  it('rejects a byte publication when the table reader consumes a word of state', () => {
    const b = fixture();
    b[0x2100] = 0xf2;
    expect(resolve(b).has(0x900)).toBe(false);
  });

  it('requires agreement across every call of the same curve', () => {
    const b = fixture();
    b.set([0xdb, 0, 0xe6, 0xfc, 0, 9, 0xda, 0, 0, 0x61, 0xdb, 0], 0x300);
    expect(resolve(b).has(0x900)).toBe(false);
  });
});
