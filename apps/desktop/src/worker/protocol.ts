import type { MapDef } from '@binanalyzer/core';
import type { Region, ScanConfig, ScanProgress } from '@binanalyzer/engine';

/** request → progress* → (result | error). Cancellation has no message: the client terminates the worker. */
export interface ScanRequest {
  id: number;
  bytes: Uint8Array;
  config?: ScanConfig;
}

export type WorkerToClient =
  | { id: number; kind: 'progress'; stage: ScanProgress['stage']; fraction: number }
  | { id: number; kind: 'result'; regions: Region[]; potentialMaps: MapDef[] }
  | { id: number; kind: 'error'; message: string };
