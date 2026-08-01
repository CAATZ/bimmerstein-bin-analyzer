import { parentPort, workerData } from 'node:worker_threads';
import { scan } from '@binanalyzer/engine';

/**
 * Scan worker (2026-07-31 MCP spec §3.4). Runs the pure engine off the stdio
 * loop; cancellation is terminate-and-respawn, the mechanism v1 spec §4
 * already documents for the desktop worker. ScanResult is plain data
 * (Region[] + MapDef[]) and therefore structured-cloneable as-is.
 */
const { buffer } = workerData as { buffer: ArrayBuffer };
try {
  const result = scan(new Uint8Array(buffer));
  parentPort?.postMessage({ ok: true, result });
} catch (e) {
  parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
