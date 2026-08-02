import { asArgs, optString, reqString } from '../args.js';
import { err, ok, requireLink, type Deps, type ToolResult, type ToolSpec } from '../result.js';

const MAP_FIELDS = ['name', 'category', 'scaling', 'notes', 'promote', 'remove', 'xAxis', 'yAxis'] as const;
const ENTRY_FIELDS = ['name', 'axis', 'notes', 'restamp', 'remove'] as const;

async function forward(deps: Deps, op: string, args: Record<string, unknown>): Promise<ToolResult> {
  const link = requireLink(deps);
  if (!link.ok) return err(link.error);
  const answer = await link.value.request<Record<string, unknown>>(op, args);
  if (!answer.ok) return err(answer.error);
  return ok({ ok: true, ...answer.value });
}

export const changeMapTool: ToolSpec = {
  name: 'change_map',
  description:
    "Change ONE map: rename, set its category or notes, set its scaling, promote a detection to confirmed, attach or detach an axis (pass null to detach), or remove it. Applies directly and is covered by the app's undo. To change more than one map, use propose_changes — the user reviews anything bulk.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['mapId'],
    properties: {
      mapId: { type: 'string', description: 'Exactly one map.' },
      name: { type: 'string' },
      category: { type: 'string', description: 'Empty string clears it.' },
      notes: { type: 'string' },
      scaling: {
        type: 'object',
        additionalProperties: false,
        properties: {
          factor: { type: 'number' }, offset: { type: 'number' },
          units: { type: 'string' }, digits: { type: 'integer' },
        },
      },
      promote: { type: 'boolean', description: "Promote one of your detections into the user's confirmed set." },
      remove: { type: 'boolean' },
      xAxis: { description: 'An axis definition, or null to detach.' },
      yAxis: { description: 'An axis definition, or null to detach.' },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    if (Array.isArray(a['mapId'])) {
      return err('change_map takes exactly one mapId — use propose_changes to change several maps at once');
    }
    const mapId = reqString(a, 'mapId');
    if (!mapId.ok) return err(mapId.error);
    const args: Record<string, unknown> = { mapId: mapId.value };
    for (const f of MAP_FIELDS) if (f in a) args[f] = a[f];
    if (Object.keys(args).length === 1) {
      return err(`provide at least one of ${MAP_FIELDS.join(', ')} alongside "mapId"`);
    }
    return forward(deps, 'change_map', args);
  },
};

export const changeAxisEntryTool: ToolSpec = {
  name: 'change_axis_entry',
  description:
    "Create, rename, edit, re-stamp or remove ONE Axis Library entry. Re-stamping pushes the entry's current definition onto every map that carries it — the app counts that as one change and one undo step.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      create: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'axis'],
        properties: { name: { type: 'string' }, axis: { type: 'object' }, notes: { type: 'string' } },
      },
      entryId: { type: 'string', description: 'An existing entry. Mutually exclusive with "create".' },
      name: { type: 'string' },
      axis: { type: 'object' },
      notes: { type: 'string' },
      restamp: { type: 'boolean' },
      remove: { type: 'boolean' },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const entryId = optString(a, 'entryId');
    if (!entryId.ok) return err(entryId.error);
    const hasCreate = a['create'] !== undefined;
    if (hasCreate === (entryId.value !== undefined)) {
      return err('provide exactly one of "create" (a new entry) or "entryId" (an existing one)');
    }
    if (hasCreate) return forward(deps, 'change_axis_entry', { create: a['create'] });

    const args: Record<string, unknown> = { entryId: entryId.value };
    for (const f of ENTRY_FIELDS) if (f in a) args[f] = a[f];
    if (Object.keys(args).length === 1) {
      return err(`provide at least one of ${ENTRY_FIELDS.join(', ')} alongside "entryId"`);
    }
    return forward(deps, 'change_axis_entry', args);
  },
};
