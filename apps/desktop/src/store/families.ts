import { writable, type Writable } from 'svelte/store';

/** A family module that is currently loaded, and where it came from. */
export interface LoadedFamily {
  familyId: string;
  /** Absolute path, or '(built-in)' for a family compiled into the app. */
  path: string;
}

/** The drop-in modules currently loaded. Built-ins are listed separately. */
export const loadedFamilies: Writable<LoadedFamily[]> = writable([]);

/**
 * Individually chosen module paths, persisted. The default folder is NOT in
 * here: it is scanned every load, so a file dropped into it needs no record.
 */
export const configuredFamilyPaths: Writable<string[]> = writable([]);

/** The slice of Web Storage this needs — injected, exactly as consent.ts does. */
export interface FamilyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const FAMILY_PATHS_KEY = 'binanalyzer.familyPaths';

/**
 * Hydrate the configured list and keep it saved. Mirrors
 * `persistCoPilotConsent`: storage that refuses to answer resolves to "none
 * configured" rather than throwing, because a webview with DOM storage
 * disabled must not take the app down.
 */
export function persistFamilyPaths(storage: FamilyStorage): () => void {
  try {
    const raw = storage.getItem(FAMILY_PATHS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    configuredFamilyPaths.set(
      Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
    );
  } catch {
    configuredFamilyPaths.set([]);
  }

  return configuredFamilyPaths.subscribe((paths) => {
    try {
      storage.setItem(FAMILY_PATHS_KEY, JSON.stringify(paths));
    } catch {
      /* Nothing to recover: the list still governs this session. */
    }
  });
}
