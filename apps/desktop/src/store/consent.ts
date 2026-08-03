import { coPilotEnabled } from './stores.js';

/**
 * The slice of the Web Storage API this needs. Injected rather than reaching
 * for `localStorage` directly so the rule "anything but a stored true is off"
 * is testable in the suite's node environment, which has no DOM storage.
 */
export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CONSENT_KEY = 'binanalyzer.coPilotEnabled';

/**
 * Persists "Share session with co-pilot" per user
 * (2026-08-01-mcp-copilot-design.md §4.5), so a user who works with a co-pilot
 * does not re-arm the link on every launch.
 *
 * Off by default is still the gate: only the exact string "true" turns it on,
 * and a storage that refuses to answer resolves to off rather than throwing —
 * a webview with DOM storage disabled must not take the app down, and must
 * never fail OPEN on a consent decision.
 */
export function persistCoPilotConsent(storage: ConsentStorage): () => void {
  let stored: string | null;
  try {
    stored = storage.getItem(CONSENT_KEY);
  } catch {
    stored = null;
  }
  coPilotEnabled.set(stored === 'true');

  return coPilotEnabled.subscribe((on) => {
    try {
      storage.setItem(CONSENT_KEY, on ? 'true' : 'false');
    } catch {
      /* Nothing to recover: the toggle still governs this session. */
    }
  });
}
