import { derived, get } from 'svelte/store';
import {
  addressFrame, axisLibrary, bin, binPath, coPilotEnabled, editJournal, maps, scanStatus, selection, viewParams,
} from '../store/stores.js';
import type { CoPilotClient } from './client.js';

/**
 * Wires consent to the client and authored-state changes to a push.
 *
 * The store list here IS the wire contract: every store buildSessionState()
 * reads must be in it, and nothing else may be — subscribing to potentialMaps
 * or regions would push megabytes of re-derivable detections on every scan.
 *
 * editJournal joined it in Part C (§3.3): without it an edit does not push and
 * the agent's working fingerprint goes stale in silence. workingBytes is NOT
 * here — it is set with the same mutated reference every time, so the journal
 * is the store that actually marks a buffer change.
 */
const authored = derived(
  [bin, binPath, maps, axisLibrary, addressFrame, selection, viewParams, scanStatus, editJournal],
  (values) => values
);

export interface CoPilotMount {
  /** The live client while consent is on, else null — the panel needs it. */
  current(): CoPilotClient | null;
  stop(): void;
}

export function mountCoPilot(make: () => CoPilotClient): CoPilotMount {
  let client: CoPilotClient | null = null;

  const stopConsent = coPilotEnabled.subscribe((on) => {
    if (on && client === null) {
      client = make();
      client.start();
    } else if (!on && client !== null) {
      client.stop();
      client = null;
    }
  });

  const stopState = authored.subscribe(() => {
    if (get(coPilotEnabled) && client !== null) client.pushState();
  });

  return {
    current: () => client,
    stop: () => {
      stopState();
      stopConsent();
      client?.stop();
      client = null;
    },
  };
}
