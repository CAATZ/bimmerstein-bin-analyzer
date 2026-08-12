import { asArgs, optString, reqString } from '../args.js';
import { MCP_CONFIG } from '../config.js';
import { err, ok, requireLink, type ToolSpec } from '../result.js';

const NO_TABLE = 'this server has no request table — it was not started in co-pilot mode';

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

/**
 * Validate one row and return its target key, or an error string.
 *
 * The target key exists because two rows aimed at the same cell are ambiguous
 * under per-item accept — checking only the second yields a different result
 * from checking both, and the panel has no honest way to render that (Part C
 * §4.2). Rows hitting the same byte through DIFFERENT maps are exotic and are
 * caught at apply time by expectedRaw instead.
 */
function checkRow(raw: unknown, index: number): { ok: true; target: string } | { ok: false; error: string } {
  const at = `edits[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${at} must be an object` };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || r['id'] === '') return { ok: false, error: `${at} needs a non-empty string "id"` };
  if (typeof r['mapId'] !== 'string' || r['mapId'] === '') return { ok: false, error: `${at} needs a string "mapId"` };
  if (typeof r['value'] !== 'number' || !Number.isFinite(r['value'])) {
    return { ok: false, error: `${at} needs a finite numeric "value"` };
  }
  if (!isInt(r['expectedRaw'])) {
    return {
      ok: false,
      error: `${at} needs an integer "expectedRaw" — the raw byte you based this edit on. Read the cell first (read_map with values:"raw" or "both"); proposing a byte you have not read is proposing blind.`,
    };
  }
  if (r['raw'] !== undefined && typeof r['raw'] !== 'boolean') {
    return { ok: false, error: `${at} "raw" must be a boolean` };
  }
  if (r['kind'] === 'cell') {
    if (!isInt(r['row']) || (r['row'] as number) < 0) return { ok: false, error: `${at} needs an integer "row" >= 0` };
    if (!isInt(r['col']) || (r['col'] as number) < 0) return { ok: false, error: `${at} needs an integer "col" >= 0` };
    return { ok: true, target: `cell:${String(r['mapId'])}:${String(r['row'])}:${String(r['col'])}` };
  }
  if (r['kind'] === 'axis') {
    if (r['axis'] !== 'x' && r['axis'] !== 'y') return { ok: false, error: `${at} needs "axis" of "x" or "y"` };
    if (!isInt(r['index']) || (r['index'] as number) < 0) return { ok: false, error: `${at} needs an integer "index" >= 0` };
    return { ok: true, target: `axis:${String(r['mapId'])}:${String(r['axis'])}:${String(r['index'])}` };
  }
  return { ok: false, error: `${at} needs "kind" of "cell" or "axis"` };
}

export const proposeMapEditsTool: ToolSpec = {
  name: 'propose_map_edits',
  description:
    'Propose byte-level VALUE changes for the user to review: map cells and referenced-axis breakpoints. EVERY value edit is a proposal, however small — there is no direct-apply path, because these bytes end up in a file that gets flashed to an ECU. The user sees each row as physical and raw before/after and accepts, partially accepts or rejects. Every row needs expectedRaw (the raw byte you read first); a row whose byte moved since you read it is skipped and reported. Returns a requestId immediately; poll get_request. Accepting the batch is ONE undo step for the user. This tool cannot save a file — only the user can do that.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'edits'],
    properties: {
      title: { type: 'string', description: 'One line the user sees at the top of the panel.' },
      reason: { type: 'string', description: 'Optional: why you are proposing this.' },
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: MCP_CONFIG.maxProposedEdits,
        description:
          'Each row: {id, kind:"cell", mapId, row, col, value, expectedRaw} or {id, kind:"axis", mapId, axis:"x"|"y", index, value, expectedRaw}. "value" is PHYSICAL unless raw:true. "id" is unique within the batch and comes back in the decision.',
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

    const edits = a['edits'];
    if (!Array.isArray(edits) || edits.length === 0) {
      return err('"edits" must be an array with at least one row');
    }
    if (edits.length > MCP_CONFIG.maxProposedEdits) {
      return err(`a proposal may carry at most ${MCP_CONFIG.maxProposedEdits} edits; got ${edits.length}`);
    }

    const ids = new Set<string>();
    const targets = new Set<string>();
    for (let i = 0; i < edits.length; i++) {
      const checked = checkRow(edits[i], i);
      if (!checked.ok) return err(checked.error);
      const id = (edits[i] as Record<string, unknown>)['id'] as string;
      if (ids.has(id)) return err(`edit ids must be unique within a proposal; "${id}" appears twice`);
      ids.add(id);
      if (targets.has(checked.target)) {
        return err(
          `two edits target the same cell or axis value (${checked.target}) — that is ambiguous when the user accepts only some rows. Send one edit per target.`
        );
      }
      targets.add(checked.target);
    }

    const link = requireLink(deps);
    if (!link.ok) return err(link.error);
    const table = deps.requests;
    if (table === undefined) return err(NO_TABLE);

    const row = table.create('map-edits', edits.length);
    // The EXISTING propose op (Part C §4.4): no new wire op, no new request
    // path, no second decision channel. The rows carry `kind` and the app's
    // dispatcher routes on it.
    const sent = await link.value.request('propose', {
      requestId: row.requestId,
      title: title.value,
      ...(reason.value !== undefined ? { reason: reason.value } : {}),
      changes: edits,
    });
    if (!sent.ok) {
      table.settle(row.requestId, { status: 'cancelled', reason: sent.error });
      return err(sent.error);
    }
    return ok({ requestId: row.requestId, status: row.status, count: edits.length });
  },
};
