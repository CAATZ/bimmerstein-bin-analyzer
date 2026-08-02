import { MCP_CONFIG } from './config.js';

export type RequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';

export interface PendingRequest {
  requestId: string;
  kind: 'proposal' | 'save';
  status: RequestStatus;
  /** Proposals only: how many changes were submitted. */
  count?: number;
  acceptedIds?: string[];
  rejectedIds?: string[];
  failed?: Array<{ id: string; error: string }>;
  /** Set when cancelled or expired. */
  reason?: string;
}

/**
 * Decisions that wait on a human (spec §7.3). An MCP tool call must never block
 * on one, so propose_changes and save_project return a requestId immediately and
 * the agent polls get_request.
 *
 * Ids are a counter, not random: tests must be able to predict them, and there
 * is nothing to guess here — the table is private to one server process.
 */
export class RequestTable {
  private readonly rows = new Map<string, PendingRequest>();
  private seq = 0;

  constructor(private readonly limit: number = MCP_CONFIG.maxTrackedRequests) {}

  create(kind: 'proposal' | 'save', count?: number): PendingRequest {
    const row: PendingRequest = {
      requestId: `r${++this.seq}`,
      kind,
      status: 'pending',
      ...(count !== undefined ? { count } : {}),
    };
    this.rows.set(row.requestId, row);
    while (this.rows.size > this.limit) {
      const oldest = this.rows.keys().next();
      if (oldest.done === true) break;
      this.rows.delete(oldest.value);
    }
    return row;
  }

  get(requestId: string): PendingRequest | undefined {
    return this.rows.get(requestId);
  }

  /** First settle wins — a late decision never overwrites a recorded outcome. */
  settle(requestId: string, patch: Partial<PendingRequest>): void {
    const row = this.rows.get(requestId);
    if (row === undefined || row.status !== 'pending') return;
    Object.assign(row, patch);
  }

  /** The link dropped: nothing pending can ever be answered. */
  cancelAll(reason: string): void {
    for (const row of this.rows.values()) {
      if (row.status === 'pending') {
        row.status = 'cancelled';
        row.reason = reason;
      }
    }
  }
}
