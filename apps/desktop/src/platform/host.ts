/**
 * The seam between UI logic and the OS (ui-architecture: ALL Tauri usage in
 * platform/). flows.ts talks to this interface; tauri.ts is the only real
 * implementation; tests use an in-memory fake.
 */

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PlatformHost {
  /** Returns the picked absolute path, or null when the user cancels. */
  openFile(title: string, filters: FileFilter[]): Promise<string | null>;
  saveFile(title: string, defaultName: string, filters: FileFilter[]): Promise<string | null>;
  readBinary(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Modal yes/no; the spec §3 sha-mismatch gate. */
  confirm(message: string, title: string): Promise<boolean>;
  /** OS file drops onto the window; resolves to an unsubscribe fn. */
  onFileDrop(handler: (paths: string[]) => void): Promise<() => void>;
}

/* Pure path helpers (Windows + POSIX separators) — no Node 'path' in the renderer. */

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i === -1 ? '' : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  if (dir === '') return name;
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + name;
  return dir + (dir.includes('\\') ? '\\' : '/') + name;
}

/** 'dump.bin' → 'dump'; only the LAST extension is stripped. */
export function stemOf(name: string): string {
  const base = basename(name);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}
