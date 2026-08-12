import { get } from 'svelte/store';
import { sha256Hex } from '@binanalyzer/core';
import {
  addressFrame, axisLibrary, bin, binPath, editJournal, maps, scanStatus, selection,
  viewParams, workingBytes,
} from '../store/stores.js';
import type { SessionState, WireWorking } from './protocol.js';

/**
 * The whole wire payload (2026-08-01-mcp-copilot-design.md §5.1). Measured at
 * 197,455 bytes for the realistic ceiling of 306 imported maps, which is why
 * the client resends it whole rather than diffing.
 *
 * potentialMaps and regions are DELIBERATELY absent: the co-pilot re-derives
 * them from the same bytes with the same deterministic engine, so sending them
 * would be a megabytes-scale duplicate of information it already has.
 */
export function buildSessionState(): SessionState {
  const image = get(bin);
  return {
    bin:
      image === null
        ? null
        : {
            sha256: image.sha256,
            name: image.name,
            size: image.size,
            path: get(binPath),
            working: workingFingerprint(),
          },
    maps: get(maps),
    axisLibrary: get(axisLibrary),
    addressFrame: get(addressFrame),
    selection: get(selection),
    viewParams: get(viewParams),
    scanStatus: get(scanStatus),
  };
}

/**
 * null while the journal is empty — the working buffer IS the original then, so
 * a clean session must not pay a 256 KB hash on every coalesced push (Part C
 * §3.3). That covers every session before its first edit, including all
 * selection dragging.
 */
function workingFingerprint(): WireWorking | null {
  const journal = get(editJournal);
  if (journal.size === 0) return null;
  const working = get(workingBytes);
  if (working === null) return null;
  return { sha256: sha256Hex(working), changedBytes: journal.size };
}
