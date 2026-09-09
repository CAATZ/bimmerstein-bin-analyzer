import { describe, it, expect } from 'vitest';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';

describe('structural-detector config defaults', () => {
  it('carries the pool.struct* fields at their pinned values', () => {
    const p = DEFAULT_SCAN_CONFIG.pool;
    expect(p.structHeaderGateMin).toBe(32);
    expect(p.structHeaderAxisMinCount).toBe(2);
    expect(p.structAxisMaxCount).toBe(64);
    expect(p.structTileFrameMin).toBe(0.75);
    expect(p.structTileMinRun).toBe(3);
    expect(p.structTilePlateauStrictMin).toBe(4);
    expect(p.trendResidualFloor).toBe(1);
  });
});
