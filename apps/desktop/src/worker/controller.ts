import { get } from 'svelte/store';
import {
  applyScanResult, pushToast, setScanCanceled, setScanError, setScanProgress, setScanRunning,
} from '../store/actions.js';
import { bin } from '../store/stores.js';
import { ScanClient, type WorkerLike } from './client.js';

/**
 * Store glue for the one app-wide scan. The `new Worker(new URL(...))` form
 * is Vite's documented worker pattern — it must stay syntactically intact.
 * The cast is needed because DOM's `Worker.onmessage` accepts a full
 * `MessageEvent` while `WorkerLike.onmessage` only needs `{ data: unknown }`;
 * under `strictFunctionTypes` that narrower property-typed member fails
 * structural assignment even though a real Worker satisfies it at runtime.
 */
const client = new ScanClient(
  () => new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
);

export function runScan(): void {
  const image = get(bin);
  if (!image) {
    pushToast('info', 'Open a bin first');
    return;
  }
  // start() BEFORE setScanRunning(): if a scan is already running, start()
  // supersedes it (terminate + onCanceled fires for the OLD scan) before
  // posting the new request — setScanRunning() must run last so the status
  // rests on 'running', not 'canceled', for the scan that is actually live
  // (reachable via drag-drop mid-scan; Toolbar's Cancel button calls
  // cancelScan() directly and is unaffected).
  client.start(image.bytes, undefined, {
    onProgress: setScanProgress,
    onResult: applyScanResult,
    onError: setScanError,
    onCanceled: setScanCanceled,
  });
  setScanRunning();
}

export function cancelScan(): void {
  client.cancel();
}

export function scanRunning(): boolean {
  return client.running;
}
