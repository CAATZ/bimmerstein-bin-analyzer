import { describe, expect, it } from 'vitest';
import { scan } from '../src/index.js';

/** THE canary: a realistic mini-bin must yield the planted map, axes attached. */
function buildMiniBin(): { bytes: Uint8Array; mapAddr: number; xAddr: number; yAddr: number } {
  const bytes = new Uint8Array(16384);
  bytes.fill(0xff, 0, 2048); // empty
  let s = 7 >>> 0; // code-like filler
  for (let i = 2048; i < 8192; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    bytes[i] = (s >>> 16) & 0xff;
  }
  const put = (off: number, v: number) => {
    bytes[off] = v >> 8;
    bytes[off + 1] = v & 0xff;
  };
  const xAddr = 9000;
  for (let i = 0; i < 8; i++) put(xAddr + 2 * i, 800 + i * 400); // x axis, 8 ascending
  const yAddr = xAddr + 16;
  for (let i = 0; i < 6; i++) put(yAddr + 2 * i, 1000 + i * 700); // y axis, 6 ascending
  const mapAddr = yAddr + 12;
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 8; c++) put(mapAddr + 2 * (r * 8 + c), 2200 + r * 90 + c * 25 + ((r + c) % 2));
  }
  bytes.fill(0xff, 14336); // trailing empty
  return { bytes, mapAddr, xAddr, yAddr };
}

describe('scan (full pipeline canary)', () => {
  it('finds the planted 6×8 map and attaches both axes', () => {
    const { bytes, mapAddr, xAddr, yAddr } = buildMiniBin();
    const progress: string[] = [];
    const result = scan(bytes, undefined, (p) => progress.push(p.stage));
    const dataLen = 6 * 8 * 2;
    const hit = result.potentialMaps.find(
      (m) =>
        Math.max(m.address, mapAddr) < Math.min(m.address + m.rows * m.cols * m.format.width, mapAddr + dataLen)
    );
    expect(hit).toBeDefined();
    expect(hit!.cols).toBe(8);
    expect(hit!.xAxis?.address).toBe(xAddr);
    expect(hit!.yAxis?.address).toBe(yAddr);
    expect(progress).toContain('regions');
    expect(progress).toContain('score');
  });
  it('is deterministic', () => {
    const { bytes } = buildMiniBin();
    expect(scan(bytes)).toEqual(scan(bytes));
  });
  it('aborts via signal', () => {
    const { bytes } = buildMiniBin();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(() => scan(bytes, undefined, undefined, ctrl.signal)).toThrow('scan aborted');
  });
});
