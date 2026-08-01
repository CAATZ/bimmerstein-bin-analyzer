import { Worker } from 'node:worker_threads';
import { scan, type ScanResult } from '@binanalyzer/engine';

export interface Scanner {
  scan(bytes: Uint8Array): Promise<ScanResult>;
  /** Terminate anything in flight. Called on transport close. */
  dispose(): Promise<void>;
}

/** Chain that runs at most one job at a time; a rejection never wedges it. */
export function serializeScans(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
}

/** In-process scanner — used by unit tests and any non-stdio caller. */
export class InlineScanner implements Scanner {
  async scan(bytes: Uint8Array): Promise<ScanResult> {
    return scan(bytes);
  }

  async dispose(): Promise<void> {
    // nothing to tear down
  }
}

interface WorkerReply {
  ok: boolean;
  result?: ScanResult;
  error?: string;
}

/**
 * Worker-backed scanner. One Worker per scan, terminated on completion or
 * cancellation, so a multi-second scan (measured: 4.8 s for a 256 KB MS41 full
 * read) never blocks the stdio protocol loop.
 */
export class WorkerScanner implements Scanner {
  private readonly enqueue = serializeScans();
  private current: Worker | undefined;

  async scan(bytes: Uint8Array): Promise<ScanResult> {
    return this.enqueue(async () => this.runOnce(bytes));
  }

  async dispose(): Promise<void> {
    const w = this.current;
    this.current = undefined;
    if (w !== undefined) await w.terminate();
  }

  private async runOnce(bytes: Uint8Array): Promise<ScanResult> {
    // A COPY: transferring the session's own buffer would detach it and break
    // every later read_map on that bin.
    const copy = bytes.slice();
    // A plain-JS bootstrap, NOT scan-worker.ts directly: the worker thread has
    // no TypeScript loader of its own, register() is per-thread, and passing
    // the parent's loader down via execArgv is not portable across Node
    // versions (see scan-worker-boot.mjs). The bootstrap registers tsx inside
    // the worker and then imports the TS body. This is a runtime URL, not a
    // module specifier, so it names the file that exists on disk.
    const entry = new URL('./scan-worker-boot.mjs', import.meta.url);
    const worker = new Worker(entry, {
      workerData: { buffer: copy.buffer },
      transferList: [copy.buffer],
    });
    this.current = worker;
    try {
      return await new Promise<ScanResult>((resolve, reject) => {
        worker.once('message', (m: WorkerReply) => {
          if (m.ok && m.result !== undefined) resolve(m.result);
          else reject(new Error(m.error ?? 'scan worker returned no result'));
        });
        worker.once('error', (e: Error) => reject(e));
        worker.once('exit', (code: number) => {
          if (code !== 0) reject(new Error(`scan worker exited with code ${code}`));
        });
      });
    } finally {
      this.current = undefined;
      await worker.terminate();
    }
  }
}
