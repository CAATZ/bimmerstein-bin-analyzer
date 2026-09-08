import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_CONFIG as cfg } from '../src/config.js';
import { scanReaderCalls } from '../src/family/ms41/c166.js';
import { saToFo } from '../src/family/ms41/frame.js';
import { detectMs41RuntimeGrids } from '../src/family/ms41/runtime-grids.js';
import type { FamilyDetection } from '../src/family/types.js';

const mov = (sa: number) => [0xe6, 0xfc, sa & 255, sa >> 8];
const call = (cpu: number) => [0xda, cpu >> 16, cpu & 255, (cpu >> 8) & 255];
function fixture(width: 1 | 2 = 1) {
  const b = new Uint8Array(0x40000);
  for (const [sa, values] of [[0x800, [4, 10, 20, 30, 40]], [0x820, [3, 10, 20, 30]], [0x840, [5, 10, 20, 30, 40, 50]]] as const) b.set(values, saToFo(sa));
  b.set([0, 8, 0x20, 8, 0x40, 8], saToFo(0x600));
  b.set([0xa8, 0x3c, 0x99, 0x43, 0xe1, 5, 0xf7, 0xf4, 0x80, 0xe9, 0xdb, 0], 0x2000);
  b.set([0xa8, 0x3c, 0x99, 0x43, 0xe1, 5, 0xf7, 0xf4, 0x81, 0xe9, 0xf7, 0xf4, 0x82, 0xe9, 0xdb, 0], 0x2040);
  b.set([0xc2, 0xfa, 0x82, 0xe9, 0xc2, 0xf1, 0x80, 0xe9, 0x1b, 0xa1, 0xc2, 0xf1, 0x81, 0xe9, 0x02, 0xf1, 0x0e, 0xfe,
    ...(width === 2 ? [0, 0x11] : []), 0, 0x1c, ...(width === 2 ? [0xa8, 0x41] : [0xa9, 0x81, 0xe1, 9]), 0xdb, 0], 0x2100);
  b.set([0xf0, 0x4c, 0, 0x4d, 0xf7, 0xf8, 0x90, 0xe9, 0xdb, 0], 0x2200);
  b.set([0xdb, 0, ...mov(0x600), ...call(0x6000), ...mov(0x602), ...call(0x6040), ...mov(0x900), ...call(0x6100), 0xdb, 0], 0xfe);
  return b;
}
const detect = (b: Uint8Array, width: 1 | 2 = 1) => detectMs41RuntimeGrids(b, scanReaderCalls(b, cfg.family.ms41.maxR12Dist), [{ target: 0x6100, width }], cfg);
const shapes = (b: Uint8Array) => detect(b).map(m => [m.address, m.rows, m.cols, m.xAxis?.address, m.yAxis?.address]);

describe('MS41 runtime grid recovery', () => {
  it('keeps a resolved caller as fallback evidence without promoting an unresolved table', () => {
    const b = fixture(), hints = new Map<number, FamilyDetection>();
    b.set([0xdb, 0, ...mov(0x900), ...call(0x6100), 0xdb, 0], 0x2fe);
    const run = () => detectMs41RuntimeGrids(b, scanReaderCalls(b, cfg.family.ms41.maxR12Dist), [{ target: 0x6100, width: 1 }], cfg, hints);
    expect(run()).toEqual([]);
    expect(hints.get(saToFo(0x900))).toMatchObject({ rows: 4, cols: 3, xAxis: { address: saToFo(0x821) } });
    // Fully resolved callers with different axes must not supply a preference.
    b.set([0xdb, 0, ...mov(0x600), ...call(0x6000), ...mov(0x604), ...call(0x6040), ...mov(0x900), ...call(0x6100), 0xdb, 0], 0x2fe);
    expect(run()).toEqual([]);
    expect(hints.size).toBe(0);
  });

  it('recovers both staged axes and cell width without adjacent headers', () => {
    for (const width of [1, 2] as const) {
      const b = fixture(width);
      expect(detect(b, width)).toMatchObject([{ address: saToFo(0x900), rows: 4, cols: 3, format: { width }, xAxis: { address: saToFo(0x821) }, yAxis: { address: saToFo(0x801) } }]);
    }
  });

  it('keeps alternate table bases paired with the axis staged on their branch', () => {
    const b = fixture();
    b.set([0x8a, 0x11, 7, 0x60, ...mov(0x602), ...call(0x6040), ...mov(0x900), 0x0d, 6,
      ...mov(0x604), ...call(0x6040), ...mov(0x980), ...call(0x6100), 0xdb, 0], 0x108);
    expect(shapes(b)).toEqual([[saToFo(0x900), 4, 3, saToFo(0x821), saToFo(0x801)], [saToFo(0x980), 4, 5, saToFo(0x841), saToFo(0x801)]]);
    b.set(mov(0x900), 0x122);
    expect(detect(b)).toEqual([]);
  });

  it('retains a shared row axis across readers, safe helpers and another column stager', () => {
    const b = fixture();
    b.set([...call(0x6200), ...mov(0x604), ...call(0x6040), ...mov(0x980), ...call(0x6100), 0xdb, 0], 0x118);
    expect(shapes(b)).toEqual([[saToFo(0x900), 4, 3, saToFo(0x821), saToFo(0x801)], [saToFo(0x980), 4, 5, saToFo(0x841), saToFo(0x801)]]);
    // A write to the row index invalidates only the later lookup.
    b[0x2206] = 0x80;
    expect(detect(b).map(m => m.address)).toEqual([saToFo(0x900)]);
  });

  it('rejects indirect stores, unknown instructions and state writes on any helper branch', () => {
    for (const body of [[0x88, 0x34, 0xdb, 0], [0x11, 0, 0xdb, 0], [0x2d, 2, 0xf7, 0xf8, 0x80, 0xe9, 0xdb, 0]]) {
      const b = fixture();
      b.set(body, 0x2200);
      b.set([...call(0x6200), ...mov(0x900), ...call(0x6100), 0xdb, 0], 0x110);
      expect(detect(b)).toEqual([]);
    }
  });

  it('rejects partial staging, overwritten arguments, blank axes and seam-crossing data', () => {
    const partial = fixture();
    partial.set([0xdb, 0], 0x204a);
    expect(detect(partial)).toEqual([]);
    const overwritten = fixture();
    overwritten.set([0x00, 0xc1, ...call(0x6100), 0xdb, 0], 0x114);
    expect(detect(overwritten)).toEqual([]);
    const blank = fixture();
    blank.set([3, 10, 10, 10], saToFo(0x820));
    expect(detect(blank)).toEqual([]);
    const seam = fixture();
    seam.set(mov(0x3ffc), 0x110);
    expect(detect(seam)).toEqual([]);
  });

  it('rejects a missing staging branch and disagreement at another call of the same table', () => {
    const b = fixture();
    b.set([0x8a, 0x11, 4, 0x60, ...mov(0x602), ...call(0x6040), ...mov(0x900), ...call(0x6100), 0xdb, 0], 0x108);
    expect(detect(b)).toEqual([]);
    const other = fixture();
    other.set([0xdb, 0, ...mov(0x900), ...call(0x6100), 0xdb, 0], 0x2fe);
    expect(detect(other)).toEqual([]);
  });

  it('treats unary word operations on R12 as argument clobbers', () => {
    for (const op of [0x81, 0x91]) {
      const b = fixture();
      b.set([op, 0xc0, ...call(0x6100), 0xdb, 0], 0x114);
      expect(detect(b)).toEqual([]);
    }
  });

  it('preserves the native word-axis count and storage width', () => {
    const b = fixture(2);
    b.set([4, 0, 10, 0, 20, 0, 30, 0, 40, 0], saToFo(0x800));
    b.set([3, 0, 10, 0, 20, 0, 30, 0], saToFo(0x820));
    b.set([0xa8, 0x3c, 0x98, 0x23, 0xf1, 0x24, 0xf7, 0xf2, 0x80, 0xe9, 0xdb, 0], 0x2000);
    b.set([0xa8, 0x3c, 0x98, 0x23, 0xf1, 0x24, 0xf7, 0xf2, 0x81, 0xe9, 0xf7, 0xf2, 0x82, 0xe9, 0xdb, 0], 0x2040);
    expect(detect(b, 2)).toMatchObject([{ rows: 4, cols: 3, xAxis: { address: saToFo(0x822), format: { width: 2 } }, yAxis: { address: saToFo(0x802), format: { width: 2 } } }]);
  });

  it('declines recursive helpers and overlapping word writes', () => {
    for (const body of [[...call(0x6200), 0xdb, 0], [0xf6, 0xf4, 0x7f, 0xe9, 0xdb, 0]]) {
      const b = fixture();
      b.set(body, 0x2200);
      b.set([...call(0x6200), ...mov(0x900), ...call(0x6100), 0xdb, 0], 0x110);
      expect(detect(b)).toEqual([]);
    }
  });

  it('requires aligned native word reads for descriptors, word axes and word cells', () => {
    const descriptor = fixture();
    descriptor.set([0x20, 8], saToFo(0x605));
    descriptor.set(mov(0x605), 0x108);
    expect(detect(descriptor)).toEqual([]);
    const cells = fixture(2);
    cells.set(mov(0x901), 0x110);
    expect(detect(cells, 2)).toEqual([]);
    const axis = fixture();
    axis.set([4, 0, 10, 0, 20, 0, 30, 0, 40, 0], saToFo(0x801));
    axis.set([1, 8], saToFo(0x600));
    axis.set([0xa8, 0x3c, 0x98, 0x23, 0xf1, 0x24, 0xf7, 0xf2, 0x80, 0xe9, 0xdb, 0], 0x2000);
    expect(detect(axis)).toEqual([]);
  });
});
