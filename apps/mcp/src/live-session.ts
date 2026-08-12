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
    this.forgetAllBut(bin.sha256);

    const bytes = await this.resolveBytes(bin.sha256, bin.path);
    const entry: OpenBin = {
      binId: bin.sha256,
      sha256: bin.sha256,
      name: bin.name,
      path: bin.path ?? '(not on disk — bytes came from the app)',
      size: bin.size,
      isFullRead: isMs41FullRead(bin.size),
      bytes,
      originalBytes: bytes,
      contentSha256: bin.sha256,
      changedBytes: 0,
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
   * otherwise silently produce detections for the wrong bytes.
   */
  private async resolveBytes(sha: string, path: string | null): Promise<Uint8Array> {
    const cached = this.bytesBySha.get(sha);
    if (cached !== undefined) return cached;

    if (path !== null) {
      const read = this.io.readBin(path);
      if (read.ok && sha256Hex(read.value.bytes) === sha) {
        this.bytesBySha.set(sha, read.value.bytes);
        return read.value.bytes;
      }
    }

    const answer = await this.link.request<{ base64: string }>('getBinBytes', { sha256: sha });
    if (!answer.ok) throw new Error(`cannot obtain the bin bytes: ${answer.error}`);
    if (typeof answer.value?.base64 !== 'string') {
      throw new Error('the app answered getBinBytes without base64 bytes — refusing to analyse an empty payload');
    }
    const bytes = new Uint8Array(Buffer.from(answer.value.base64, 'base64'));
    const got = sha256Hex(bytes);
    if (got !== sha) {
      throw new Error(
        `the app sent bytes whose sha256 is ${got.slice(0, 12)}…, expected ${sha.slice(0, 12)}… — refusing to analyse them`
      );
    }
    this.bytesBySha.set(sha, bytes);
    return bytes;
  }

  private forgetAllBut(sha: string): void {
    for (const map of [this.bytesBySha, this.scans, this.axes, this.imports] as Array<Map<string, unknown>>) {
      for (const key of [...map.keys()]) if (key !== sha) map.delete(key);
    }
  }
}
