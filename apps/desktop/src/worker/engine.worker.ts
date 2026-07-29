import { DEFAULT_SCAN_CONFIG, scan } from '@binanalyzer/engine';
import type { ScanRequest, WorkerToClient } from './protocol.js';

/**
 * Thin worker host around engine scan() (spec §4 contracts). scan() is
 * synchronous — this handler holds the thread until done, which is exactly
 * why it lives in a worker and why cancel = terminate on the client side.
 */
const ctx = self as unknown as {
  postMessage(message: WorkerToClient): void;
  onmessage: ((event: MessageEvent<ScanRequest>) => void) | null;
};

ctx.onmessage = (event) => {
  const { id, bytes, config } = event.data;
  try {
    const result = scan(bytes, config ?? DEFAULT_SCAN_CONFIG, (p) =>
      ctx.postMessage({ id, kind: 'progress', stage: p.stage, fraction: p.fraction })
    );
    ctx.postMessage({ id, kind: 'result', regions: result.regions, potentialMaps: result.potentialMaps });
  } catch (err) {
    ctx.postMessage({ id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
