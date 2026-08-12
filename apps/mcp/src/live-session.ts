import { createHash } from 'node:crypto';
import type { PrefixedAxis } from '@binanalyzer/engine';
import { isMs41FullRead } from '@binanalyzer/appkit';
import type { CoPilotLink } from './link/server.js';
import type { FileIo } from './fsio.js';
import type { CachedScan, ImportedDefs, OpenBin, OpenResult, SessionStore } from './session.js';

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * SessionStore over the live desktop session (spec §5).
 *
 * Exactly one bin — whichever the app has open — so the LRU does not apply
 * (P5). The scan and detected-axis caches are the CO-PILOT'S OWN, over its own
 * scan of the same bytes; they are keyed by sha256 and dropped when the app
 * opens a different bin.
 *
 * node:crypto, not @noble/hashes: that package belongs to packages/core and is
 * deliberately not a dependency of this one (see config.ts).
 */
export class LiveSessionStore implements SessionStore {
  private readonly bytesBySha = new Map<string, Uint8Array>();
  private readonly scans = new Map<string, CachedScan>();
  private readonly axes = new Map<string, PrefixedAxis[]>();
  private readonly imports = new Map<string, ImportedDefs>();

  constructor(
    private readonly link: CoPilotLink,
    private readonly io: FileIo
  ) {}

  /** Not reachable: open_bin is withheld in co-pilot mode (spec §8). */
  async open(_entry: OpenBin): Promise<OpenResult> {
    throw new Error('open_bin is not available in co-pilot mode — the user opens bins in the app');
  }

  async get(binId: string): Promise<OpenBin | undefined> {
    const state = this.link.state();
    const bin = state?.bin;
    if (state === null || state === undefined || bin === null || bin === undefined) return undefined;
    if (bin.sha256 !== binId) return undefined;

    const working = bin.working;
    const contentSha = working === null ? bin.sha256 : working.sha256;
    this.forgetAllBut(bin.sha256, contentSha);

    const originalBytes = await this.resolveBytes({
      contentSha: bin.sha256,
      binSha: bin.sha256,
      path: bin.path,
      which: 'original',
    });
    const bytes =
      working === null
        ? originalBytes
        : await this.resolveBytes({
            // No file on disk holds edited bytes, so `path` is null here and
            // the disk fast path is unreachable for a dirty session (§3.4).
            contentSha: working.sha256,
            binSha: bin.sha256,
            path: null,
            which: 'working',
          });

    const entry: OpenBin = {
      binId: bin.sha256,
      sha256: bin.sha256,
      name: bin.name,
      path: bin.path ?? '(not on disk — bytes came from the app)',
      size: bin.size,
      isFullRead: isMs41FullRead(bin.size),
      bytes,
      originalBytes,
      contentSha256: contentSha,
      changedBytes: working === null ? 0 : working.changedBytes,
      confirmed: state.maps,
    };
    const scan = this.scans.get(bin.sha256);
    if (scan !== undefined) entry.scan = scan;
    const axes = this.axes.get(bin.sha256);
    if (axes !== undefined) entry.detectedAxes = axes;
    const imported = this.imports.get(bin.sha256);
    if (imported !== undefined) entry.imported = imported;
    return entry;
  }

  async list(): Promise<OpenBin[]> {
    const sha = this.link.state()?.bin?.sha256;
    if (sha === undefined) return [];
    const entry = await this.get(sha);
    return entry === undefined ? [] : [entry];
  }

  async setScan(binId: string, scan: CachedScan): Promise<void> {
    this.scans.set(binId, scan);
  }

  async setImported(binId: string, imported: ImportedDefs): Promise<void> {
    this.imports.set(binId, imported);
  }

  async setDetectedAxes(binId: string, axes: PrefixedAxis[]): Promise<void> {
    this.axes.set(binId, axes);
  }

  /** Nothing is ever evicted here — there is one bin and the user owns it. */
  async evictedPath(_binId: string): Promise<string | undefined> {
    return undefined;
  }

  /**
   * Path first, verified by hash; the link second. Bytes whose sha256 does not
   * match what the app reported are NEVER used — a moved or replaced file would
   * otherwise silently produce detections for the wrong bytes, and a payload
   * truncated in transit would parse as plausible garbage.
   *
   * Cached by CONTENT sha, not by binId, so the working buffer and the original
   * coexist and neither can ever be served under the other's name.
   */
  private async resolveBytes(args: {
    contentSha: string;
    binSha: string;
    path: string | null;
    which: 'original' | 'working';
  }): Promise<Uint8Array> {
    const { contentSha, binSha, path, which } = args;
    const cached = this.bytesBySha.get(contentSha);
    if (cached !== undefined) return cached;

    if (path !== null) {
      const read = this.io.readBin(path);
      if (read.ok && sha256Hex(read.value.bytes) === contentSha) {
        this.bytesBySha.set(contentSha, read.value.bytes);
        return read.value.bytes;
      }
    }

    const answer = await this.link.request<{ base64: string }>('getBinBytes', {
      sha256: binSha,
      which,
    });
    if (!answer.ok) throw new Error(`cannot obtain the bin bytes: ${answer.error}`);
    if (typeof answer.value?.base64 !== 'string') {
      throw new Error('the app answered getBinBytes without base64 bytes — refusing to analyse an empty payload');
    }
    const bytes = new Uint8Array(Buffer.from(answer.value.base64, 'base64'));
    const got = sha256Hex(bytes);
    if (got !== contentSha) {
      throw new Error(
        `the app sent ${which} bytes whose sha256 is ${got.slice(0, 12)}…, expected ${contentSha.slice(0, 12)}… — refusing to analyse them`
      );
    }
    this.bytesBySha.set(contentSha, bytes);
    return bytes;
  }

  /**
   * Keeps the original AND the current working buffer; everything else goes.
   * Superseded working buffers are dropped here as editing proceeds, so the
   * byte cache stays at two entries however long the session runs.
   */
  private forgetAllBut(binSha: string, contentSha: string): void {
    for (const key of [...this.bytesBySha.keys()]) {
      if (key !== binSha && key !== contentSha) this.bytesBySha.delete(key);
    }
    for (const map of [this.scans, this.axes, this.imports] as Array<Map<string, unknown>>) {
      for (const key of [...map.keys()]) if (key !== binSha) map.delete(key);
    }
  }
}
