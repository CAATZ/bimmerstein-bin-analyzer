import { describe, expect, it } from 'vitest';
import { CONFIG_VERSION, MCP_CONFIG } from '../src/config.js';

describe('MCP_CONFIG', () => {
  it('pins the adapter caps the spec fixes', () => {
    expect(MCP_CONFIG.maxOpenBins).toBe(4);
    expect(MCP_CONFIG.maxBinBytes).toBe(16 * 1024 * 1024);
    expect(MCP_CONFIG.listMapsDefaultLimit).toBe(50);
    expect(MCP_CONFIG.listMapsMaxLimit).toBe(200);
    expect(MCP_CONFIG.listAxesDefaultLimit).toBe(100);
    expect(MCP_CONFIG.listAxesMaxLimit).toBe(500);
    expect(MCP_CONFIG.readMapMaxCells).toBe(4096);
    expect(MCP_CONFIG.readBytesDefaultLength).toBe(256);
    expect(MCP_CONFIG.readBytesMaxLength).toBe(4096);
    expect(MCP_CONFIG.readBytesDefaultCols).toBe(16);
    expect(MCP_CONFIG.maxRegionsReturned).toBe(64);
    expect(MCP_CONFIG.maxWarningsReturned).toBe(50);
    expect(MCP_CONFIG.importSampleSize).toBe(5);
    expect(MCP_CONFIG.exportMaxInlineChars).toBe(400_000);
  });
});

describe('CONFIG_VERSION', () => {
  it('is a stable 16-hex-char identity of the engine default config', () => {
    expect(CONFIG_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic across imports', async () => {
    const again = (await import('../src/config.js')).CONFIG_VERSION;
    expect(again).toBe(CONFIG_VERSION);
  });
});
