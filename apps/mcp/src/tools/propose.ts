import { asArgs, optString, reqString } from '../args.js';
import { MCP_CONFIG } from '../config.js';
import { err, ok, requireLink, type ToolSpec } from '../result.js';

const NO_TABLE = 'this server has no request table — it was not started in co-pilot mode';

/**
 * Submit a batch for the user to review. Returns immediately: a proposal waits
 * on a human and may sit for minutes, and an MCP call must never block on that
 * (spec §7.3). The agent polls get_request.
 */
export const proposeChangesTool: ToolSpec = {
  name: 'propose_changes',
  description:
    'Propose a batch of changes for the user to review. They see one row per change and accept all, some, or none. Use this for anything touching more than one map — bulk naming, bulk categorisation, axis re-stamping across maps, bulk removal. Returns a requestId immediately; poll get_request for the outcome. Accepting the batch is ONE undo step for the user.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'changes'],
    properties: {
      title: { type: 'string', description: 'One line the user sees at the top of the panel.' },
      reason: { type: 'string', description: 'Optional: why you are proposing this.' },
      changes: {
        type: 'array',
        minItems: 1,
        maxItems: MCP_CONFIG.maxProposedChanges,
        description:
          'Each item is a change_map or change_axis_entry payload plus a required "id" unique within the batch, which the decision refers back to.',
        items: { type: 'object' },
      },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const title = reqString(a, 'title');
    if (!title.ok) return err(title.error);
    const reason = optString(a, 'reason');
    if (!reason.ok) return err(reason.error);

    const changes = a['changes'];
    if (!Array.isArray(changes) || changes.length === 0) {
      return err('"changes" must be an array with at least one change');
    }
    if (changes.length > MCP_CONFIG.maxProposedChanges) {
      return err(`a proposal may carry at most ${MCP_CONFIG.maxProposedChanges} changes; got ${changes.length}`);
    }
    const ids = new Set<string>();
    for (const c of changes) {
      const id = (c as Record<string, unknown>)['id'];
      if (typeof id !== 'string' || id === '') return err('every change needs a string "id"');
      if (ids.has(id)) return err(`change ids must be unique within a proposal; "${id}" appears twice`);
      ids.add(id);
    }

    const link = requireLink(deps);
    if (!link.ok) return err(link.error);
    const table = deps.requests;
    if (table === undefined) return err(NO_TABLE);

    const row = table.create('proposal', changes.length);
    const sent = await link.value.request('propose', {
      requestId: row.requestId,
      title: title.value,
      ...(reason.value !== undefined ? { reason: reason.value } : {}),
      changes,
    });
    if (!sent.ok) {
      table.settle(row.requestId, { status: 'cancelled', reason: sent.error });
      return err(sent.error);
    }
    return ok({ requestId: row.requestId, status: row.status, count: changes.length });
  },
};

export const getRequestTool: ToolSpec = {
  name: 'get_request',
  description:
    'Poll a deferred request from propose_changes, import_definition or save_project. Status is pending until the user decides, then accepted (with acceptedIds/rejectedIds), rejected, cancelled or expired. There is no timeout on the user.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['requestId'],
    properties: { requestId: { type: 'string' } },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const id = reqString(a, 'requestId');
    if (!id.ok) return err(id.error);
    const table = deps.requests;
    if (table === undefined) return err(NO_TABLE);
    const row = table.get(id.value);
    if (row === undefined) {
      return err(
        `unknown requestId "${id.value}" — it may have aged out of the bounded table (${MCP_CONFIG.maxTrackedRequests} kept)`
      );
    }
    return ok(row);
  },
};
