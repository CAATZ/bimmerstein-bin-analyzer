import type { ScanConfig, ScanProgress, ScanResult } from '@binanalyzer/engine';
import type { ScanRequest, WorkerToClient } from './protocol.js';

/**
 * Client-side scan protocol. scan() is SYNCHRONOUS inside the worker, so a
 * cancel message would queue behind the running scan and never be seen —
 * cancel() therefore terminates the worker and the next start() respawns one
 * (decided in task 5.13). Message ids
 * make stale results from a superseded scan harmless.
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export interface ScanCallbacks {
  onProgress(stage: ScanProgress['stage'], fraction: number): void;
  onResult(result: ScanResult): void;
  onError(message: string): void;
  onCanceled(): void;
}

export class ScanClient {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private activeId = 0;
  private callbacks: ScanCallbacks | null = null;

  constructor(private readonly createWorker: WorkerFactory) {}

  get running(): boolean {
    return this.activeId !== 0;
  }

  start(bytes: Uint8Array, config: ScanConfig | undefined, callbacks: ScanCallbacks): void {
    if (this.running) this.cancel(); // one scan at a time
    this.worker ??= this.attach(this.createWorker());
    const id = this.nextId++;
    this.activeId = id;
    this.callbacks = callbacks;
    const request: ScanRequest = config === undefined ? { id, bytes } : { id, bytes, config };
    this.worker.postMessage(request);
  }

  cancel(): void {
    if (!this.running) return;
    const cb = this.callbacks;
    this.worker?.terminate(); // the only way to stop a synchronous scan
    this.worker = null;
    this.activeId = 0;
    this.callbacks = null;
    cb?.onCanceled();
  }

  private attach(worker: WorkerLike): WorkerLike {
    worker.onmessage = (event) => {
      const msg = event.data as WorkerToClient;
      if (msg.id !== this.activeId || this.callbacks === null) return; // stale
      if (msg.kind === 'progress') {
        this.callbacks.onProgress(msg.stage, msg.fraction);
        return;
      }
      const cb = this.callbacks;
      this.activeId = 0;
      this.callbacks = null;
      if (msg.kind === 'result') cb.onResult({ regions: msg.regions, potentialMaps: msg.potentialMaps });
      else cb.onError(msg.message);
    };
    return worker;
  }
}
