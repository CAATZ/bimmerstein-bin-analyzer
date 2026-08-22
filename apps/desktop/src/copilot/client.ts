import { coPilotStatus } from '../store/stores.js';
import { applyProposal, dispatchOp } from './dispatch.js';
import { PROTOCOL_VERSION, decodeServerFrame, type ClientFrame } from './protocol.js';
import { buildSessionState } from './wire-state.js';

/** Measured reconnect shape (spec §4.4): three orders proven, cold connect 27 ms. */
export const BACKOFF_MS = [250, 500, 1000, 2000, 4000];

export interface SocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
}

export interface ClientDeps {
  connect(url: string): SocketLike;
  /** Reads the handshake file; null when it is absent or unreadable. */
  readLink(): Promise<{ port: number; token: string } | null>;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** Runs the app's own Save flow. Resolves TRUE only if a file was written. */
  saveProject(): Promise<boolean>;
}

const OPEN = 1;

export class CoPilotClient {
  private socket: SocketLike | null = null;
  private attempts = 0;
  private seq = 0;
  private retryHandle: unknown = null;
  private pushHandle: unknown = null;
  private running = false;

  constructor(private readonly deps: ClientDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    coPilotStatus.set('waiting');
    void this.dial();
  }

  stop(): void {
    this.running = false;
    if (this.retryHandle !== null) this.deps.cancel(this.retryHandle);
    if (this.pushHandle !== null) this.deps.cancel(this.pushHandle);
    this.retryHandle = null;
    this.pushHandle = null;
    this.socket?.close();
    this.socket = null;
    coPilotStatus.set('off');
  }

  /** Coalesced: a drag that touches the selection many times per second sends one state. */
  pushState(): void {
    if (this.pushHandle !== null) return;
    this.pushHandle = this.deps.schedule(() => {
      this.pushHandle = null;
      this.sendNow();
    }, 0);
  }

  /** Apply the user's decision locally, then tell the server which rows landed. */
  decideProposal(requestId: string, acceptedIds: string[]): void {
    const outcome = applyProposal(requestId, acceptedIds);
    this.send({
      v: PROTOCOL_VERSION,
      type: 'decision',
      id: requestId,
      accepted: outcome.accepted,
      rejected: outcome.rejected,
      // Only when non-empty: a save_project decision has no rows at all.
      ...(outcome.failed.length > 0 ? { failed: outcome.failed } : {}),
    });
    this.pushState(); // the batch changed authored state
  }

  private sendNow(): void {
    const s = this.socket;
    if (s === null || s.readyState !== OPEN) return;
    this.send({ v: PROTOCOL_VERSION, type: 'state', seq: ++this.seq, payload: buildSessionState() });
  }

  private send(frame: ClientFrame): void {
    const s = this.socket;
    if (s === null || s.readyState !== OPEN) return;
    s.send(JSON.stringify(frame));
  }

  private async dial(): Promise<void> {
    if (!this.running) return;
    // Re-read every attempt: a restarted server writes a NEW port and token.
    const link = await this.deps.readLink();
    if (link === null) {
      this.scheduleRetry();
      return;
    }
    const socket = this.deps.connect(`ws://127.0.0.1:${link.port}/?token=${link.token}`);
    this.socket = socket;

    socket.onopen = (): void => {
      this.attempts = 0;
      this.seq = 0;
      coPilotStatus.set('connected');
      this.sendNow(); // a fresh connection always starts with a full state
    };
    socket.onmessage = (e): void => void this.receive(String(e.data));
    socket.onerror = (): void => {
      /* 'close' always follows */
    };
    socket.onclose = (): void => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.running) return;
      coPilotStatus.set('disconnected');
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]!;
    this.attempts++;
    this.retryHandle = this.deps.schedule(() => {
      this.retryHandle = null;
      void this.dial();
    }, delay);
  }

  private async receive(text: string): Promise<void> {
    const decoded = decodeServerFrame(text);
    // A frame we cannot validate is dropped in silence: replying to it would
    // mean answering something we did not understand.
    if (!decoded.ok) return;
    const frame = decoded.value;
    if (frame.type !== 'request') return;

    if (frame.op === 'save_project') {
      // The dispatcher has no PlatformHost, so the client fulfils this one.
      // Acknowledge at once — the user may sit in a file dialog for minutes —
      // and report the outcome with a decision frame afterwards.
      this.send({ v: PROTOCOL_VERSION, type: 'response', id: frame.id, ok: true, value: { started: true } });
      const requestId = String((frame.args as Record<string, unknown> | null)?.['requestId'] ?? frame.id);
      // The app is the authority (spec §11): a cancelled dialog or a failed
      // write is a rejection, not a save. Reporting it as accepted would tell
      // the agent the user's work is on disk when it is not.
      const saved = await this.deps.saveProject();
      this.send({
        v: PROTOCOL_VERSION,
        type: 'decision',
        id: requestId,
        accepted: saved ? [requestId] : [],
        rejected: saved ? [] : [requestId],
      });
      return;
    }

    const result = await dispatchOp(frame.op, frame.args);
    this.send(
      result.ok
        ? { v: PROTOCOL_VERSION, type: 'response', id: frame.id, ok: true, value: result.value }
        : { v: PROTOCOL_VERSION, type: 'response', id: frame.id, ok: false, error: result.error }
    );
  }
}
