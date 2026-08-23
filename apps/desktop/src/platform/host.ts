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
  /**
   * Write bytes, replacing any existing file. The ONLY binary write in the app
   * (2026-08-11-binary-write-path §2) — every caller goes through the bin save
   * flow, and a guard test pins that.
   */
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Read a text file, or null when it is absent/unreadable. Never throws. */
  readTextIfExists(path: string): Promise<string | null>;
  /**
   * Absolute paths of the files directly inside `path` — NOT recursive, and an
   * absent directory is an empty list, not an error. Used only to find drop-in
   * family modules (2026-08-23-drop-in-family-modules-design.md §3).
   */
  readDir(path: string): Promise<string[]>;
  /** Create `path` and any missing parents. A directory that already exists is not an error. */
  mkdirp(path: string): Promise<void>;
  /** Modal yes/no; the spec §3 sha-mismatch gate. */
  confirm(message: string, title: string): Promise<boolean>;
  /** OS file drops onto the window; resolves to an unsubscribe fn. */
  onFileDrop(handler: (paths: string[]) => void): Promise<() => void>;
  /**
   * The user asked to close the window. `handler` returns whether the close may
   * proceed; resolves to an unsubscribe fn.
   *
   * Registering this TAKES OWNERSHIP of closing: Tauri's `onCloseRequested`
   * destroys the window itself when the handler does not prevent the default,
   * which is why the app needs `core:window:allow-destroy`. Without that
   * permission this listener would make the app unquittable rather than merely
   * unguarded.
   */
  onCloseRequested(handler: () => Promise<boolean>): Promise<() => void>;
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

/**
 * Do two paths name the same file? Separators are normalised and the comparison
 * is ALSO case-insensitive, which over-matches on case-sensitive filesystems.
 * That is deliberate: the only caller uses it to refuse overwriting the image
 * the user opened, and a false "these are the same file" costs a rename while a
 * false "these differ" costs the original firmware.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const x = norm(a);
  const y = norm(b);
  return x === y || x.toLowerCase() === y.toLowerCase();
}

/** 'dump.bin' → 'dump'; only the LAST extension is stripped. */
export function stemOf(name: string): string {
  const base = basename(name);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}
