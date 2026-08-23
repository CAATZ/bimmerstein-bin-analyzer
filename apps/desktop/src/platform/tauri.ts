import { confirm as dialogConfirm, open, save } from '@tauri-apps/plugin-dialog';
import { exists, mkdir, readDir, readFile, readTextFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
  writeBinary: (path: string, bytes: Uint8Array) => writeFile(path, bytes),
  exists: (path: string) => exists(path),
  /**
   * Uses the fs scope the app already has (`fs:scope **` plus
   * `fs:allow-read-text-file`) — no new Tauri capability. Absent, unreadable
   * and malformed all collapse to null so the co-pilot dial just retries.
   */
  async readDir(path: string): Promise<string[]> {
    try {
      const entries = await readDir(path);
      return entries.filter((e) => e.isFile).map((e) => `${path}/${e.name}`);
    } catch {
      // Absent directory, or a platform that refuses to list it: an empty list
      // is the honest answer and keeps startup non-fatal.
      return [];
    }
  },
  async mkdirp(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true });
    } catch {
      /* Already there, or not creatable — the caller's readDir will report []. */
    }
  },
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

  /**
   * Tauri's own onCloseRequested destroys the window when the handler does not
   * call preventDefault (see @tauri-apps/api window.js), so this listener is
   * what actually closes the app — hence `core:window:allow-destroy` in
   * capabilities/default.json. Deny that permission and the app stops being
   * closable at all.
   */
  async onCloseRequested(handler: () => Promise<boolean>): Promise<() => void> {
    return await getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await handler())) event.preventDefault();
    });
  },
};
