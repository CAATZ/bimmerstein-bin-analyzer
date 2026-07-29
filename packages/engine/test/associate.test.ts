import { describe, expect, it } from 'vitest';
import { associate, findAnchor } from '../src/associate.js';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import type { AxisCandidate } from '../src/axes.js';
import type { TableCandidate } from '../src/tables.js';
import type { ValueFormat } from '@binanalyzer/core';

const u16be: ValueFormat = { width: 2, signed: false, endianness: 'big' };

describe('associate', () => {
  it('attaches [x][y][data] layout axes by count and proximity', () => {
    // x axis (8 values) at 100..116, y axis (6 values) at 116..128, table at 128
    const axes: AxisCandidate[] = [
      { address: 100, count: 8, format: u16be, direction: 'inc', score: 0.5 },
      { address: 116, count: 6, format: u16be, direction: 'inc', score: 0.4 },
      { address: 900, count: 8, format: u16be, direction: 'inc', score: 0.9 }, // far away decoy AFTER table
    ];
    const tables: TableCandidate[] = [{ address: 128, rows: 6, cols: 8, format: u16be, score: 0.8 }];
    const [r] = associate(tables, axes, DEFAULT_SCAN_CONFIG);
    expect(r!.xAxis?.address).toBe(100);
    expect(r!.yAxis?.address).toBe(116);
    expect(r!.axisFit).toBeGreaterThan(0.4);
  });
  it('no axes in range → axisFit 0, table still emitted', () => {
    const tables: TableCandidate[] = [{ address: 5000, rows: 4, cols: 4, format: u16be, score: 0.7 }];
    const [r] = associate(tables, [], DEFAULT_SCAN_CONFIG);
    expect(r!.xAxis).toBeUndefined();
    expect(r!.yAxis).toBeUndefined();
    expect(r!.axisFit).toBe(0);
  });
});

describe('findAnchor', () => {
  const table: TableCandidate = { address: 128, rows: 3, cols: 4, format: u16be, score: 0.6 };
  const ax = (address: number, count: number): AxisCandidate => ({
    address, count, format: u16be, direction: 'inc', score: 0.5,
  });

  it('detects an exact zero-gap [x][y][data] chain', () => {
    // x: 4 cells [114,122) ends at y start; y: 3 cells [122,128) ends at table
    const anchor = findAnchor(table, [ax(114, 4), ax(122, 3)], DEFAULT_SCAN_CONFIG);
    expect(anchor).toEqual({
      exact: true,
      xAddress: 114, xCount: 4, xFormat: u16be,
      yAddress: 122, yCount: 3, yFormat: u16be,
    });
  });

  it('rejects a gapped chain at anchorMaxGap 0 but accepts it within a configured gap', () => {
    // y [120,126) ends 2 bytes short of the table; x [112,120) ends at y start
    const axes = [ax(112, 4), ax(120, 3)];
    expect(findAnchor(table, axes, DEFAULT_SCAN_CONFIG)).toBeUndefined();
    const relaxed = {
      ...DEFAULT_SCAN_CONFIG,
      associate: { ...DEFAULT_SCAN_CONFIG.associate, anchorMaxGap: 2 },
    };
    const anchor = findAnchor(table, axes, relaxed);
    expect(anchor?.yAddress).toBe(120);
    expect(anchor?.xAddress).toBe(112);
  });

  it('derives the y window from a covering fused run (distinct from the x run)', () => {
    // Fused run [118,134) covers the y window [122,128); x is an exact 4-cell run ending at 122.
    const anchor = findAnchor(table, [ax(114, 4), ax(118, 8)], DEFAULT_SCAN_CONFIG);
    expect(anchor).toEqual({
      exact: false,
      xAddress: 114, xCount: 4, xFormat: u16be,
      yAddress: 122, yCount: 3, yFormat: u16be,
    });
  });

  it('refuses to carve both windows from the same run', () => {
    // One long run [100,140) covers both the y window [122,128) and the x window [114,122).
    expect(findAnchor(table, [ax(100, 20)], DEFAULT_SCAN_CONFIG)).toBeUndefined();
  });
});
