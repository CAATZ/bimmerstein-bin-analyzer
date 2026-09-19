import { writable } from 'svelte/store';
import type { ConsentStorage } from './consent.js';

export interface WorkspacePreferences {
  sidebarWidth: number;
  previewWidth: number;
  previewHeight: number;
  previewPosition: 'right' | 'bottom';
  tableFontSize: number;
  heatmap: boolean;
}

export const DEFAULT_WORKSPACE: WorkspacePreferences = {
  sidebarWidth: 300, previewWidth: 360, previewHeight: 280,
  previewPosition: 'bottom', tableFontSize: 13, heatmap: false,
};
export const WORKSPACE_KEY = 'binanalyzer.workspace';
export const workspace = writable<WorkspacePreferences>({ ...DEFAULT_WORKSPACE });

export function setWorkspace(patch: Partial<WorkspacePreferences>): void {
  workspace.update((value) => ({ ...value, ...patch }));
}

/** Presentation preferences never enter the project or its undo history. */
export function persistWorkspace(storage: ConsentStorage): () => void {
  const next = { ...DEFAULT_WORKSPACE };
  try {
    const stored: unknown = JSON.parse(storage.getItem(WORKSPACE_KEY) ?? 'null');
    if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
      const value = stored as Record<string, unknown>;
      for (const [key, min, max] of [
        ['sidebarWidth', 180, 2400], ['previewWidth', 240, 2400],
        ['previewHeight', 180, 1600], ['tableFontSize', 11, 18],
      ] as const) {
        const n = value[key];
        if (typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max) next[key] = Math.round(n);
      }
      if (value.previewPosition === 'right' || value.previewPosition === 'bottom') next.previewPosition = value.previewPosition;
      if (typeof value.heatmap === 'boolean') next.heatmap = value.heatmap;
    }
  } catch { /* Defaults remain usable when storage is unavailable. */ }
  workspace.set(next);
  return workspace.subscribe((value) => {
    try { storage.setItem(WORKSPACE_KEY, JSON.stringify(value)); }
    catch { /* Keep this window's preferences when persistence is unavailable. */ }
  });
}
