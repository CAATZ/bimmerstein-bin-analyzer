import { describe, it, expect } from 'vitest';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import { scanPrefixedAxes } from '../src/pool.js';

const data = (start: number, end: number) => [{ start, end, kind: 'data' as const }];

describe('scanPrefixedAxes', () => {
  it('finds a u8 count-prefixed monotone run', () => {
    const bytes = new Uint8Array(64);
    bytes.set([8, 10, 25, 40, 70, 100, 140, 190, 240], 16); // [n=8][8 ascending cells]
    const hits = scanPrefixedAxes(bytes, data(0, 64), DEFAULT_SCAN_CONFIG);
    const hit = hits.find((h) => h.address === 17 && h.count === 8 && h.format.width === 1);
    expect(hit).toBeDefined();
    expect(hit!.end).toBe(25);
    expect(hit!.maximal).toBe(true); // next byte is 0 — breaks the ascending trend
  });

  it('finds a u16-LE count-prefixed monotone run', () => {
    const bytes = new Uint8Array(64);
    const words = [5, 500, 900, 1400, 2000, 2700]; // [n=5][5 ascending u16-LE]
    words.forEach((v, i) => {
      bytes[20 + 2 * i] = v & 0xff;
      bytes[21 + 2 * i] = v >> 8;
    });
    const hits = scanPrefixedAxes(bytes, data(0, 64), DEFAULT_SCAN_CONFIG);
    const hit = hits.find((h) => h.address === 22 && h.count === 5 && h.format.width === 2 && h.format.endianness === 'little');
    expect(hit).toBeDefined();
    expect(hit!.end).toBe(32);
  });

  it('flags non-maximal runs (trend continues past cell n)', () => {
    const bytes = new Uint8Array(64);
    bytes.set([4, 10, 20, 30, 40, 50], 8); // cell 4 (value 50) continues the ascent
    const hits = scanPrefixedAxes(bytes, data(0, 64), DEFAULT_SCAN_CONFIG);
    const hit = hits.find((h) => h.address === 9 && h.count === 4 && h.format.width === 1);
    expect(hit).toBeDefined();
    expect(hit!.maximal).toBe(false);
  });

  it('subsumes nested aliases (first cell value == count − 1)', () => {
    const bytes = new Uint8Array(64);
    // [6][5, 10, 20, 30, 40, 50]: the 5 inside spawns phantom [5][10,20,30,40,50]
    bytes.set([6, 5, 10, 20, 30, 40, 50], 8);
    const hits = scanPrefixedAxes(bytes, data(0, 64), DEFAULT_SCAN_CONFIG);
    expect(hits.find((h) => h.address === 9 && h.count === 6)).toBeDefined();
    expect(hits.find((h) => h.address === 10 && h.count === 5)).toBeUndefined();
  });

  it('respects axis.minCount and region boundaries', () => {
    const bytes = new Uint8Array(64);
    bytes.set([3, 10, 20, 30], 8); // n=3 < minCount 4
    bytes.set([8, 10, 25, 40, 70, 100, 140, 190, 240], 40); // valid, but region ends at 40
    const hits = scanPrefixedAxes(bytes, data(0, 40), DEFAULT_SCAN_CONFIG);
    expect(hits.find((h) => h.address === 9)).toBeUndefined();
    expect(hits.find((h) => h.address === 41)).toBeUndefined();
  });
});

import { buildPoolIndex, findPoolAnchor, poolAnchors, isPoolActive, poolAdjacentTables, type PrefixedAxis } from '../src/pool.js';

describe('poolAdjacentTables', () => {
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  const pax = (address: number, count: number, maximal = true): PrefixedAxis => ({
    address, count, format: u8, end: address + count, maximal,
  });
  // Tight packing [rowAxis@100 #10][colAxis@111 #10][table@121]: colAxis's
  // count-prefix (110) sits exactly at rowAxis.end (110). Mirrors the real MS41
  // FlexFuel layout (a non-maximal col-axis whose run continues into the table).
  const rowAxis = pax(100, 10);
  const colAxis = pax(111, 10, false); // non-maximal: run continues into the 0x80 table

  it('places a dead/uniform table at the terminal col-axis boundary with the pair as axes', () => {
    const bytes = new Uint8Array(256);
    bytes.fill(0x80, 121, 221); // uniform 10×10 table at colAxis.end
    const pts = poolAdjacentTables(bytes, [rowAxis, colAxis], DEFAULT_SCAN_CONFIG);
    const t = pts.find((p) => p.address === 121);
    expect(t).toBeDefined();
    expect([t!.rows, t!.cols]).toEqual([10, 10]);
    expect(t!.xAxis.address).toBe(111); // column axis = the one adjacent to the table
    expect(t!.yAxis.address).toBe(100); // row axis = the one before it
  });

  it('does NOT place a table where the region is non-uniform (byte scanner owns those)', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 100; i++) bytes[121 + i] = 100 + (i % 7); // range > 0
    const pts = poolAdjacentTables(bytes, [rowAxis, colAxis], DEFAULT_SCAN_CONFIG);
    expect(pts.find((p) => p.address === 121)).toBeUndefined();
  });

  it('emits only the TERMINAL table in a tight axis chain (no intermediate phantom)', () => {
    // [a1@100 #10][a2@111 #10][a3@122 #10][table@132]
    const a1 = pax(100, 10);
    const a2 = pax(111, 10);
    const a3 = pax(122, 10, false);
    const bytes = new Uint8Array(256);
    // Fill the a2-PHANTOM region [121,221) uniformly too, so the UNIFORM guard
    // would ACCEPT it — the TERMINAL guard (start 121 == a3's prefix) must be
    // the sole thing that rejects it. (If it weren't uniform, the uniform guard
    // alone would reject the phantom and this test wouldn't exercise TERMINAL.)
    bytes.fill(0x80, 121, 232);
    const pts = poolAdjacentTables(bytes, [a1, a2, a3], DEFAULT_SCAN_CONFIG);
    expect(pts.find((p) => p.address === 132)).toBeDefined(); // terminal kept
    expect(pts.find((p) => p.address === 121)).toBeUndefined(); // a2-phantom rejected by TERMINAL guard alone
  });

  it('requires the row-axis to end exactly at the col-axis prefix (tight packing)', () => {
    const bytes = new Uint8Array(256);
    bytes.fill(0x80, 121, 221);
    const looseRow = pax(90, 10); // ends at 100, not at colAxis prefix (110)
    expect(poolAdjacentTables(bytes, [looseRow, colAxis], DEFAULT_SCAN_CONFIG).find((p) => p.address === 121)).toBeUndefined();
  });
});

describe('findPoolAnchor', () => {
  const u8 = { width: 1, signed: false, endianness: 'big' } as const;
  const pax = (address: number, count: number, maximal = true): PrefixedAxis => ({
    address, count, format: u8, end: address + count, maximal,
  });
  const table = { address: 1000, rows: 6, cols: 8 };

  it('exposes tied and farther eligible pairs for review without changing the selected pair', () => {
    const pool = [pax(500, 8), pax(510, 6), pax(680, 6), pax(690, 6), pax(700, 8),
      pax(750, 6, false), pax(1000, 6), pax(100, 6)];
    const index = buildPoolIndex(pool);
    const choices = [...poolAnchors(table, index, DEFAULT_SCAN_CONFIG)];
    expect(choices.map(p => [p.x.address, p.y.address])).toEqual([[700, 690], [700, 680], [500, 510]]);
    expect(findPoolAnchor(table, index, DEFAULT_SCAN_CONFIG)).toEqual(choices[0]);
    expect([...poolAnchors({ ...table, address: 4000 }, index, DEFAULT_SCAN_CONFIG)]).toEqual([]);
    const square = [...poolAnchors({ ...table, rows: 8 }, buildPoolIndex([pax(700, 8), pax(709, 8)]), DEFAULT_SCAN_CONFIG)];
    expect(square.map(p => [p.x.address, p.y.address])).toEqual([[709, 700], [700, 709]]);
  });

  it('binds the nearest preceding maximal pair with counts (cols, rows)', () => {
    const pool = [pax(500, 8), pax(510, 6), pax(700, 8), pax(709, 6)];
    const a = findPoolAnchor(table, buildPoolIndex(pool), DEFAULT_SCAN_CONFIG);
    expect(a).toBeDefined();
    expect(a!.x.address).toBe(700); // nearest pair wins over the farther 500/510 pair
    expect(a!.y.address).toBe(709);
  });

  it('ignores non-maximal hits', () => {
    const pool = [pax(700, 8, false), pax(709, 6), pax(500, 8), pax(510, 6)];
    const a = findPoolAnchor(table, buildPoolIndex(pool), DEFAULT_SCAN_CONFIG);
    expect(a!.x.address).toBe(500); // the nearer 8-count is non-maximal → farther pair
  });

  it('requires the pair members within pairSpan of each other', () => {
    const pool = [pax(300, 8), pax(700, 6)]; // 392 bytes apart > pairSpan 64
    expect(findPoolAnchor(table, buildPoolIndex(pool), DEFAULT_SCAN_CONFIG)).toBeUndefined();
  });

  it('requires distinct addresses when rows === cols', () => {
    const square = { address: 1000, rows: 8, cols: 8 };
    expect(findPoolAnchor(square, buildPoolIndex([pax(700, 8)]), DEFAULT_SCAN_CONFIG)).toBeUndefined();
    const a = findPoolAnchor(square, buildPoolIndex([pax(700, 8), pax(709, 8)]), DEFAULT_SCAN_CONFIG);
    expect(a).toBeDefined();
    expect(a!.x.address).not.toBe(a!.y.address);
  });

  it('respects the window (pool axes too far before the table)', () => {
    const pool = [pax(100, 8), pax(109, 6)]; // ends ~885 bytes… make it beyond window
    const far = { address: 4000, rows: 6, cols: 8 };
    expect(findPoolAnchor(far, buildPoolIndex(pool), DEFAULT_SCAN_CONFIG)).toBeUndefined();
  });

  it('never binds axes at or past the table start', () => {
    const pool = [pax(1000, 8), pax(1009, 6)];
    expect(findPoolAnchor(table, buildPoolIndex(pool), DEFAULT_SCAN_CONFIG)).toBeUndefined();
  });
});

describe('isPoolActive', () => {
  const maximalAt = (address: number): PrefixedAxis => ({
    address,
    count: 4,
    format: { width: 1, signed: false, endianness: 'big' },
    end: address + 4,
    maximal: true,
  });

  it('is true when the maximal-prefixed-axis count meets activateMinCount', () => {
    const prefixed = Array.from({ length: DEFAULT_SCAN_CONFIG.pool.activateMinCount }, (_, i) => maximalAt(i * 8));
    expect(isPoolActive(prefixed, DEFAULT_SCAN_CONFIG)).toBe(true);
  });

  it('is false when the maximal-prefixed-axis count is below activateMinCount', () => {
    const prefixed = Array.from({ length: DEFAULT_SCAN_CONFIG.pool.activateMinCount - 1 }, (_, i) => maximalAt(i * 8));
    expect(isPoolActive(prefixed, DEFAULT_SCAN_CONFIG)).toBe(false);
  });

  it('does not count non-maximal hits toward the threshold', () => {
    const nonMaximal: PrefixedAxis = { ...maximalAt(0), maximal: false };
    const prefixed = Array.from({ length: DEFAULT_SCAN_CONFIG.pool.activateMinCount + 5 }, () => nonMaximal);
    expect(isPoolActive(prefixed, DEFAULT_SCAN_CONFIG)).toBe(false);
  });
});
