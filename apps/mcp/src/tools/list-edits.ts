import { checksumsFor } from '@binanalyzer/families';
import { MCP_CONFIG } from '../config.js';
import { asArgs, optInt, optOneOf, optString, reqString } from '../args.js';
import { attributeEdits, type ChecksumPair, type EditRow } from '../edits.js';
import { sourcedMaps } from '../maps.js';
import { diffPair } from '../session.js';
import { err, ok, unknownBin, type ToolSpec } from '../result.js';

const KINDS = ['cell', 'axis', 'checksum', 'raw'] as const;

const EMPTY_NOTE =
  'This session has no edits: no byte differs from the file as opened. Nothing is wrong - the user has not changed a value yet, or changed one and put it back.';

/** Join the two verify() reports by block id — a block only in one contributes nothing. */
function checksumPairs(working: Uint8Array, original: Uint8Array): ChecksumPair[] {
  const family = checksumsFor(working);
  if (family === undefined) return [];
  const before = new Map(family.verify(original).blocks.map((b) => [b.id, b]));
  const out: ChecksumPair[] = [];
  for (const now of family.verify(working).blocks) {
    const was = before.get(now.id);
    if (was === undefined) continue;
    out.push({
      id: now.id,
      storedAt: now.storedAt,
      originalStored: was.stored,
      currentStored: now.stored,
      correctable: now.correctable,
    });
  }
  return out;
}

const matchesMap = (row: EditRow, want: string): boolean =>
  (row.kind === 'cell' && row.mapId === want) || (row.kind === 'axis' && row.mapIds.includes(want));

export const listEditsTool: ToolSpec = {
  name: 'list_edits',
  description:
    'What currently differs from the file as opened, attributed to the map cells, axis entries and checksum fields the changed bytes belong to. This is CURRENT STATE, not a history: there is no ordering, no timestamps, and no record of who made a change — the app keeps only what differs, so a value edited and put back is not reported at all. Checksum rows appear after a save that corrected a block; the user did not type those.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['binId'],
    properties: {
      binId: { type: 'string', description: 'sha256 handle from open_bin.' },
      mapId: {
        type: 'string',
        description: 'Show only edits belonging to this map. Accepts confirmed, imported and potential ids.',
      },
      kind: {
        enum: [...KINDS],
        description:
          'cell = inside a map; axis = an axis entry; checksum = written by a save correction; raw = changed bytes no definition covers.',
      },
      offset: { type: 'integer', minimum: 0, default: 0 },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MCP_CONFIG.listEditsMaxLimit,
        default: MCP_CONFIG.listEditsDefaultLimit,
      },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const id = reqString(a, 'binId');
    if (!id.ok) return err(id.error);
    const mapId = optString(a, 'mapId');
    if (!mapId.ok) return err(mapId.error);
    const kind = optOneOf(a, 'kind', KINDS);
    if (!kind.ok) return err(kind.error);
    const offset = optInt(a, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    if (!offset.ok) return err(offset.error);
    const limit = optInt(a, 'limit', MCP_CONFIG.listEditsDefaultLimit, 1, MCP_CONFIG.listEditsMaxLimit);
    if (!limit.ok) return err(limit.error);

    const entry = await deps.store.get(id.value);
    if (entry === undefined) return await unknownBin(deps, id.value);

    const { working, original } = diffPair(entry);
    const maps = sourcedMaps(entry, 'all');
    if (!maps.ok) return err(maps.error);

    const out = attributeEdits({
      working,
      original,
      maps: maps.value,
      checksums: checksumPairs(working, original),
    });

    let rows = out.rows;
    if (mapId.value !== undefined) {
      const want = mapId.value;
      rows = rows.filter((r) => matchesMap(r, want));
    }
    if (kind.value !== undefined) rows = rows.filter((r) => r.kind === kind.value);

    const page = rows.slice(offset.value, offset.value + limit.value);
    return ok({
      binId: entry.binId,
      changedBytes: out.changedBytes,
      summary: out.summary,
      edits: page,
      total: rows.length,
      offset: offset.value,
      limit: limit.value,
      hasMore: offset.value + page.length < rows.length,
      // Present ONLY when there is nothing to show, so an agent does not read
      // an empty list as a broken tool and retry it.
      ...(out.changedBytes === 0 ? { note: EMPTY_NOTE } : {}),
    });
  },
};
