import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SNAP_MAX_BYTES/min-size guard in snap.ts must derive its lower bound
 * from DEFAULT_SCAN_CONFIG.table.minRows/minCols, not a hardcoded literal —
 * mocking the engine's own config (minRows bumped past the real value of 2)
 * proves the guard tracks minRows rather than assuming it's always 2.
 */
vi.mock('@binanalyzer/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@binanalyzer/engine')>();
  return {
    ...actual,
    DEFAULT_SCAN_CONFIG: {
      ...actual.DEFAULT_SCAN_CONFIG,
      table: { ...actual.DEFAULT_SCAN_CONFIG.table, minRows: 5, minCols: 2 },
    },
    scanTables: vi.fn(() => []),
  };
});

const U8 = { width: 1, signed: false, endianness: 'little' } as const;

describe('snapSelection size guard (mocked minRows=5, minCols=2, width=1 -> threshold 10)', () => {
  beforeEach(async () => {
    const { scanTables } = await import('@binanalyzer/engine');
    vi.mocked(scanTables).mockClear();
  });

  it('short-circuits below minRows*minCols*width without consulting the engine scanner', async () => {
    const { scanTables } = await import('@binanalyzer/engine');
    const { snapSelection } = await import('../src/lib/snap.js');
    const bytes = new Uint8Array(64);
    // 6 bytes: below the mocked threshold of 10 — a stale hardcoded "2*minCols*w" (=4)
    // would let this through to the engine; the fix must not.
    expect(snapSelection(bytes, 0, 6, U8)).toBeNull();
    expect(scanTables).not.toHaveBeenCalled();
  });

  it('consults the engine scanner once the selection reaches the threshold', async () => {
    const { scanTables } = await import('@binanalyzer/engine');
    const { snapSelection } = await import('../src/lib/snap.js');
    const bytes = new Uint8Array(64);
    expect(snapSelection(bytes, 0, 10, U8)).toBeNull(); // mocked scanTables returns []
    expect(scanTables).toHaveBeenCalledTimes(1);
  });
});
