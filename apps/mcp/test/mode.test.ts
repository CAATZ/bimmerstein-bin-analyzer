import { describe, expect, it } from 'vitest';
import { COPILOT_TOOLS, HEADLESS_TOOLS } from '../src/tools/index.js';
import { requireLink } from '../src/result.js';
import { fakeDeps } from './helpers.js';

const names = (ts: Array<{ name: string }>): string[] => ts.map((t) => t.name).sort();

describe('tool registries diverge by mode (spec §8)', () => {
  it('headless is exactly the Phase-1 ten', () => {
    expect(names(HEADLESS_TOOLS)).toEqual([
      'export_definition', 'get_map', 'import_definition', 'list_bins',
      'list_detected_axes', 'list_maps', 'open_bin', 'read_bytes', 'read_map', 'scan_bin',
    ]);
  });

  it('co-pilot withholds open_bin and list_bins — the user opens bins', () => {
    expect(names(COPILOT_TOOLS)).not.toContain('open_bin');
    expect(names(COPILOT_TOOLS)).not.toContain('list_bins');
  });

  it('neither mode ships load_project', () => {
    expect(names(COPILOT_TOOLS)).not.toContain('load_project');
    expect(names(HEADLESS_TOOLS)).not.toContain('load_project');
  });

  it('both modes keep the fingerprint-keyed readers', () => {
    for (const set of [HEADLESS_TOOLS, COPILOT_TOOLS]) {
      for (const n of ['read_map', 'read_bytes', 'get_map', 'list_detected_axes', 'export_definition', 'scan_bin', 'list_maps']) {
        expect(names(set)).toContain(n);
      }
    }
  });

  it('every registered tool has a unique name and an object input schema', () => {
    for (const set of [HEADLESS_TOOLS, COPILOT_TOOLS]) {
      expect(new Set(names(set)).size).toBe(set.length);
      for (const t of set) expect(t.inputSchema['type']).toBe('object');
    }
  });
});

describe('requireLink', () => {
  it('names the flag in headless mode', () => {
    const r = requireLink(fakeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--copilot');
  });

  it('names the toggle when the app is not connected', () => {
    const link = {
      connected: () => false,
      state: () => null,
      async request() { return { ok: false as const, error: 'x' }; },
      onDisconnect() {},
      onDecision() {},
      async close() {},
    };
    const r = requireLink({ ...fakeDeps(), link });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Share session with co-pilot');
  });
});
