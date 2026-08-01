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

  /**
   * @param loaderUrl ESM loader to give the worker thread. The workspace ships
   *   raw TypeScript, so the worker cannot start without one; the launcher
   *   resolves tsx's loader and passes it through BINALYZER_TSX_LOADER
   *   (register() is per-thread and is NOT inherited by workers).
   */
  constructor(private readonly loaderUrl: string | undefined = process.env['BINALYZER_TSX_LOADER']) {}

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
    // NOTE: '.ts', not '.js'. This is a runtime URL, not a module specifier —
    // tsx rewrites specifiers, not `new URL(...)` strings, so this must name
    // the file that actually exists on disk.
    const entry = new URL('./scan-worker.ts', import.meta.url);
    const worker = new Worker(entry, {
      workerData: { buffer: copy.buffer },
      transferList: [copy.buffer],
      ...(this.loaderUrl !== undefined ? { execArgv: ['--import', this.loaderUrl] } : {}),
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
