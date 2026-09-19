import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE, WORKSPACE_KEY, persistWorkspace, workspace } from '../src/store/workspace.js';
import { heatColor } from '../src/lib/presentation.js';

describe('workspace preferences', () => {
  it('restores only valid display preferences and persists changes across mounts', () => {
    let data = JSON.stringify({ sidebarWidth: 380, previewHeight: 300, previewWidth: 440,
      previewPosition: 'right', tableFontSize: 16, heatmap: true });
    const storage = { getItem: (key: string) => { expect(key).toBe(WORKSPACE_KEY); return data; },
      setItem: (_key: string, value: string) => { data = value; } };
    let stop = persistWorkspace(storage);
    expect(get(workspace)).toEqual(JSON.parse(data));
    expect(get(workspace).sidebarWidth).toBe(380);
    workspace.update((v) => ({ ...v, tableFontSize: 18 }));
    stop();
    workspace.set({ ...DEFAULT_WORKSPACE });
    stop = persistWorkspace(storage);
    expect(get(workspace).tableFontSize).toBe(18);
    stop();
  });

  it('falls back for malformed data, invalid fields, and unavailable storage', () => {
    for (const data of ['bad', 'null', '[]', '{"sidebarWidth":-1,"tableFontSize":999,"heatmap":"true","previewPosition":"floating"}']) {
      const stop = persistWorkspace({ getItem: () => data, setItem: () => {} });
      expect(get(workspace)).toEqual(DEFAULT_WORKSPACE);
      stop();
    }
    const stop = persistWorkspace({ getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } });
    expect(get(workspace)).toEqual(DEFAULT_WORKSPACE);
    expect(() => workspace.update((v) => ({ ...v, sidebarWidth: 320 }))).not.toThrow();
    stop();
  });
});

describe('shared surface colors', () => {
  it('orders physical values, clamps endpoints and handles flat or non-finite data', () => {
    expect(heatColor(-20, -20, 80)).not.toBe(heatColor(80, -20, 80));
    expect(heatColor(-200, -20, 80)).toBe(heatColor(-20, -20, 80));
    expect(heatColor(200, -20, 80)).toBe(heatColor(80, -20, 80));
    expect(heatColor(7, 7, 7)).toBe(heatColor(0.5, 0, 1));
    expect(heatColor(NaN, 0, 1)).toBe('transparent');
    expect(heatColor(1, 0, Infinity)).toBe('transparent');
  });
});
