import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_CONFIG as cfg } from '../src/config.js';
import { analyzeMs41Consumers } from '../src/family/ms41/consumers.js';
import { detectMs41Params } from '../src/family/ms41/params.js';
import { saToFo } from '../src/family/ms41/frame.js';

const word = (n: number) => [n & 255, n >> 8];
function image(base = 0x620, descriptor = 0x5300) {
  const b = new Uint8Array(0x40000);
  b.set(word(base), saToFo(descriptor));
  b.set([0xe6, 0xf4, ...word(descriptor), 0xf6, 0xf4, 0x20, 0xe9, 0xdb, 0], 0x100);
  b.set([0xf2, 0xf4, 0x20, 0xe9, 0xa8, 0x54, 0xf6, 0xf5, 0x40, 0xe9, 0xdb, 0], 0x200);
  b.set([0xf2, 0xf4, 0x40, 0xe9, 0xf4, 0xa4, 2, 0, 0xf7, 0xfa, 0x60, 0xe9,
    0xf4, 0x64, 3, 0, 0xf7, 0xf6, 0x61, 0xe9, 0xdb, 0], 0x300);
  b.set([0xc2, 0xf5, 0x60, 0xe9, 0x68, 0x51, 0x2d, 0, 0xc2, 0xf5, 0x61, 0xe9, 0x68, 0x52, 0xdb, 0], 0x400);
  b.set([0x26, 0xc0], saToFo(base + 2));
  return b;
}
const detect = (b: Uint8Array, config = cfg) => detectMs41Params(b, config, analyzeMs41Consumers(b, [], new Map(), config).memory);
const recovered = (b: Uint8Array, base = 0x620, config = cfg) => detect(b, config).filter(p => p.address >= saToFo(base + 2) && p.address <= saToFo(base + 3));

describe('cached calibration byte parameters', () => {
  it.each([[0x620, 0x5300], [2, 0x4e00], [0x4320, 0x5200]])('recovers relocated bytes through both pointer publications (%i)', (base, descriptor) => {
    const found = recovered(image(base, descriptor), base);
    expect(found).toMatchObject([2, 3].map(offset => ({address: saToFo(base + offset), rows: 1, cols: 1, kind: 'param', format: {width: 1, signed: false}})));
    expect(found.every(p => p.states === undefined)).toBe(true);
  });

  it('requires a consumed publication rather than a discarded load or integrity read', () => {
    const b = image(); b.fill(0, 0x400, 0x410);
    expect(detect(b)).toEqual([]);
    b.set([0xf2, 0xf4, 0x40, 0xe9, 0xa9, 0xa4, 0x49, 0xa0, 0xdb, 0], 0x300);
    expect(detect(b)).toEqual([]);
  });

  it.each([
    [0xe6, 0xf5, 0x40, 0x06, 0xf6, 0xf5, 0x40, 0xe9],
    [0xe7, 0xf8, 0, 0, 0xf7, 0xf8, 0x41, 0xe9],
    [0xf6, 0xf5, 0x40, 0xe9],
    [0x64, 0xf5, 0x40, 0xe9],
  ].map(writer => [writer]))('rejects conflicting, partial or unresolved cache writers: %j', writer => {
    const b = image(); b.set([...writer, 0xdb, 0], 0x500);
    expect(detect(b)).toEqual([]);
  });

  it('accepts a second publication only when it resolves to the same word', () => {
    const b = image(); b.set([0xe6, 0xf5, 0x20, 0x06, 0xf6, 0xf5, 0x40, 0xe9, 0xdb, 0], 0x500);
    expect(recovered(b)).toHaveLength(2);
  });

  it.each([[0xe1, 0x08], [0xe1, 0x09], [0x81, 0x40], [0x11, 0x00], [0xda, 0, 0, 0x60]].map(clobber => [clobber]))('rejects aliased clobbers and unknown or called effects: %j', clobber => {
    const b = image();const tail = b.slice(0x304, 0x316);
    b.set([...clobber, ...tail], 0x304);
    expect(detect(b)).toEqual([]);
  });

  it('rejects cyclic caches and analysis bound exhaustion', () => {
    const b = image(); b.set([0xf2, 0xf4, 0x40, 0xe9], 0x100);
    expect(detect(b)).toEqual([]);
    for (const limits of [{consumerMaxDepth: 1}, {consumerMaxInstructions: 2}]) {
      const small = {...cfg, family: {...cfg.family, ms41: {...cfg.family.ms41, ...limits}}};
      expect(detect(image(), small)).toEqual([]);
    }
  });

  it('rejects an alternate entry after pointer setup and mismatched byte publication', () => {
    const b = image(); b.set([0xea, 0, 0x04, 0x43], 0x500); // CPU 4304 -> file 304
    expect(detect(b)).toEqual([]);
    const c = image(); c[0x309] = 0xf8; c[0x311] = 0xf8;
    expect(detect(c)).toEqual([]);
  });

  it.each([0xffff, 0x8000, 0x5fff])('rejects erased or out-of-calibration pointers (%i)', base => {
    const b = image(); b.set(word(base), saToFo(0x5300));
    expect(detect(b)).toEqual([]);
  });

  it('rejects a misaligned descriptor and preserves direct parameter precedence', () => {
    const b = image(); b[0x102] = 1;
    expect(detect(b)).toEqual([]);
    const c = image(); c.set([0xf3, 0xf8, 0x22, 0x06, 0x49, 0x80, 0xdb, 0], 0x500);
    expect(recovered(c)).toHaveLength(2);
    expect(detectMs41Params(image(), cfg).filter(p => p.address === saToFo(0x622))).toEqual([]);
  });
});
