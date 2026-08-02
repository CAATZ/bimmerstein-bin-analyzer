import { get } from 'svelte/store';
import {
  addressFrame, axisLibrary, bin, binPath, maps, scanStatus, selection, viewParams,
} from '../store/stores.js';
import type { SessionState } from './protocol.js';

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
        : { sha256: image.sha256, name: image.name, size: image.size, path: get(binPath) },
    maps: get(maps),
    axisLibrary: get(axisLibrary),
    addressFrame: get(addressFrame),
    selection: get(selection),
    viewParams: get(viewParams),
    scanStatus: get(scanStatus),
  };
}
