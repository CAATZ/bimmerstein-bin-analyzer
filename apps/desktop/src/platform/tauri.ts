import { confirm as dialogConfirm, open, save } from '@tauri-apps/plugin-dialog';
import { exists, readFile, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { FileFilter, PlatformHost } from './host.js';

/**
 * Real PlatformHost on Tauri 2 (plugin APIs verified against the v2 docs +
 * plugin sources, 2026-07-08). Paths picked via the dialog plugin are
 * auto-added to the fs scope; dropped paths rely on the fs:scope wildcard in
 * capabilities/default.json (task 5.1).
 */
export const tauriHost: PlatformHost = {
  async openFile(title: string, filters: FileFilter[]): Promise<string | null> {
    const picked = await open({ title, filters, multiple: false, directory: false });
    return typeof picked === 'string' ? picked : null;
  },

  async saveFile(title: string, defaultName: string, filters: FileFilter[]): Promise<string | null> {
    return await save({ title, defaultPath: defaultName, filters });
  },

  readBinary: (path: string) => readFile(path),
  readText: (path: string) => readTextFile(path),
  writeText: (path: string, contents: string) => writeTextFile(path, contents),
  exists: (path: string) => exists(path),
  /**
   * Uses the fs scope the app already has (`fs:scope **` plus
   * `fs:allow-read-text-file`) — no new Tauri capability. Absent, unreadable
   * and malformed all collapse to null so the co-pilot dial just retries.
   */
  readTextIfExists: async (path: string): Promise<string | null> => {
    try {
      return (await exists(path)) ? await readTextFile(path) : null;
    } catch {
      return null;
    }
  },

  confirm: (message: string, title: string) => dialogConfirm(message, { title, kind: 'warning' }),

  async onFileDrop(handler: (paths: string[]) => void): Promise<() => void> {
    return await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'drop') handler(event.payload.paths);
    });
  },
};
