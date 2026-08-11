import { get } from 'svelte/store';
import type { AxisDef, MapDef, Scaling } from '@binanalyzer/core';
import * as actions from '../store/actions.js';
import { pushToast } from '../store/actions.js';
import { undoTransaction } from '../store/undo.js';
import {
  bin, maps, potentialMaps, proposals, selection, viewParams,
  type Proposal, type ViewMode,
} from '../store/stores.js';

export type DispatchResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

const okv = (value: Record<string, unknown> = {}): DispatchResult => ({ ok: true, value });
const fail = (error: string): DispatchResult => ({ ok: false, error });

/**
 * The uniform no-bin error (2026-08-01-mcp-copilot-design.md §5.4). It names
 * the recovery action deliberately: opening a bin is the USER's action in
 * co-pilot mode — open_bin is not in this mode's tool set — so an agent that
 * only hears "no bin" has nothing to do next. The control is the toolbar's
 * "Open Bin" button; this app has no menu bar.
 */
export const NO_BIN_OPEN =
  'no bin is open in the app — ask the user to open one (Open Bin in the toolbar), then retry.';

/**
 * Burst escalation (2026-08-01-mcp-copilot-design.md §7.1). The split rule is
 * "more than one map -> he proposes"; without this an agent could decompose a
 * bulk change into N single calls and never show the user a panel.
 */
export const SINGLE_CHANGE_BURST = 5;
export const SINGLE_CHANGE_WINDOW_MS = 10_000;
let recentChanges: number[] = [];

/** Test hook — also called when the session resets. */
export function resetBurstWindow(): void {
  recentChanges = [];
}

function wouldEscalate(): boolean {
  const now = Date.now();
  recentChanges = recentChanges.filter((t) => now - t < SINGLE_CHANGE_WINDOW_MS);
  if (recentChanges.length >= SINGLE_CHANGE_BURST) return true;
  recentChanges.push(now);
  return false;
}

const asRecord = (x: unknown): Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

function findAnyMap(id: string): MapDef | undefined {
  return get(maps).find((m) => m.id === id) ?? get(potentialMaps).find((m) => m.id === id);
}

const VIEW_MODES: ViewMode[] = ['hex', '2d', '3d', 'map'];

function queueProposal(p: Proposal): void {
  proposals.update((ps) => [...ps, p]);
}

/**
 * The ONE place a wire op becomes an app action. Every mutating branch routes
 * through an existing actions.ts function, so validation and error text are
 * identical to the UI's and there is no second validation path.
 */
export async function dispatchOp(op: string, rawArgs: unknown): Promise<DispatchResult> {
  const args = asRecord(rawArgs);
  const image = get(bin);

  switch (op) {
    case 'select': {
      if (image === null) return fail(NO_BIN_OPEN);
      const mapId = args['mapId'];
      if (typeof mapId === 'string') {
        const map = findAnyMap(mapId);
        if (map === undefined) return fail(`no map with id ${mapId} in the app`);
        actions.selectMap(map);
        return okv({ applied: get(selection) });
      }
      const address = Number(args['address']);
      const length = Number(args['length'] ?? 1);
      if (!Number.isInteger(address) || address < 0) {
        return fail('"address" must be a non-negative integer file offset');
      }
      if (!Number.isInteger(length) || length < 1) return fail('"length" must be a positive integer');
      const cols = args['cols'] === undefined ? undefined : Number(args['cols']);
      actions.setSelection(address, address + length, cols);
      return okv({ applied: get(selection) });
    }

    case 'show': {
      if (image === null) return fail(NO_BIN_OPEN);
      const mode = args['viewMode'];
      if (typeof mode === 'string') {
        if (!VIEW_MODES.includes(mode as ViewMode)) return fail(`viewMode must be one of ${VIEW_MODES.join(', ')}`);
        actions.setViewMode(mode as ViewMode);
      }
      if (args['address'] !== undefined) {
        const address = Number(args['address']);
        if (!Number.isInteger(address) || address < 0) {
          return fail('"address" must be a non-negative integer file offset');
        }
        actions.requestScroll(address);
      }
      return okv({ applied: { viewMode: get(viewParams).viewMode } });
    }

    case 'open_map': {
      if (image === null) return fail(NO_BIN_OPEN);
      const mapId = args['mapId'];
      if (typeof mapId !== 'string') return fail('"mapId" is required');
      const map = findAnyMap(mapId);
      if (map === undefined) return fail(`no map with id ${mapId} in the app`);
      actions.selectMap(map);
      actions.setViewMode(map.rows === 1 || map.cols === 1 ? 'map' : '3d');
      return okv({ applied: { mapId, viewMode: get(viewParams).viewMode } });
    }

    case 'change_map':
    case 'change_axis_entry': {
      if (image === null) return fail(NO_BIN_OPEN);
      if (wouldEscalate()) {
        const requestId = `burst-${get(proposals).length}-${op}`;
        queueProposal({
          requestId,
          title: 'The co-pilot is making many changes in a row',
          reason: 'Escalated automatically: more than five single changes inside ten seconds.',
          changes: [{ id: 'c1', op, ...args }],
        });
        return okv({ escalated: true, requestId });
      }
      const result = applyChange(op, args);
      // Spec §7.1: a single Change is "applied directly, snapshotted, toasted".
      // Without the toast the user learns about a co-pilot edit only by
      // noticing it. An accepted proposal is NOT toasted here — the user
      // decided that one themselves, and 306 toasts would bury the app.
      if (result.ok) pushToast('info', changeToastText(op, args, result.value));
      return result;
    }

    case 'propose': {
      const requestId = args['requestId'];
      const title = args['title'];
      const changes = args['changes'];
      if (typeof requestId !== 'string' || requestId === '') return fail('"requestId" is required');
      if (typeof title !== 'string' || title === '') return fail('"title" is required');
      if (!Array.isArray(changes) || changes.length === 0) return fail('"changes" must be a non-empty array');
      queueProposal({
        requestId,
        title,
        ...(typeof args['reason'] === 'string' ? { reason: args['reason'] } : {}),
        changes: changes as Proposal['changes'],
      });
      return okv({ queued: changes.length });
    }

    case 'save_project':
      // The client owns the PlatformHost, so it intercepts this before dispatch.
      return fail('save_project is handled by the client, not the dispatcher');

    case 'getBinBytes': {
      if (image === null) return fail(NO_BIN_OPEN);
      const want = args['sha256'];
      if (typeof want === 'string' && want !== image.sha256) {
        return fail('the app has a different bin open now — call get_session again');
      }
      let binary = '';
      // ORIGINAL bytes on purpose: the agent verifies sha256 against bin's
      // identity, so edited bytes under the original's hash would fail that check.
      for (const byte of image.bytes) binary += String.fromCharCode(byte);
      return okv({ base64: btoa(binary), sha256: image.sha256 });
    }

    default:
      return fail(`unknown co-pilot op "${op}"`);
  }
}

/** Names what the co-pilot just did, in the same words the sidebar uses. */
function changeToastText(
  op: string,
  args: Record<string, unknown>,
  value: Record<string, unknown>
): string {
  if (op === 'change_map') {
    if (args['remove'] === true) return `Co-pilot removed map ${String(args['mapId'])}`;
    const map = value['map'] as MapDef | undefined;
    return `Co-pilot changed "${map?.name ?? String(args['mapId'])}"`;
  }
  if (args['remove'] === true) return `Co-pilot removed axis entry ${String(args['entryId'])}`;
  if (args['restamp'] === true) {
    return `Co-pilot re-stamped ${String(value['updated'] ?? 0)} maps from an axis entry`;
  }
  const entry = value['entry'] as { name?: string } | undefined;
  return `Co-pilot changed axis "${entry?.name ?? String(args['entryId'])}"`;
}

/** Applies ONE change through the matching actions.ts mutator. */
export function applyChange(op: string, args: Record<string, unknown>): DispatchResult {
  if (op === 'change_map') return applyMapChange(args);
  if (op === 'change_axis_entry') return applyAxisEntryChange(args);
  if (args['addMap'] !== undefined) {
    const added = actions.addImportedMaps([args['addMap'] as MapDef]);
    return added.added === 1 ? okv({ added: 1 }) : fail(added.skipped[0] ?? 'map rejected');
  }
  return fail(`unknown change kind "${op}"`);
}

function applyMapChange(args: Record<string, unknown>): DispatchResult {
  const mapId = args['mapId'];
  if (typeof mapId !== 'string') return fail('"mapId" is required');

  if (args['promote'] === true && !actions.promoteMap(mapId)) {
    return fail(`no potential map with id ${mapId}`);
  }
  if (args['remove'] === true) {
    if (!get(maps).some((m) => m.id === mapId)) return fail(`no confirmed map with id ${mapId}`);
    actions.removeMap(mapId);
    return okv({ removed: mapId });
  }

  const patch: actions.MapMetaPatch = {};
  if (typeof args['name'] === 'string') patch.name = args['name'];
  if (typeof args['category'] === 'string') patch.category = args['category'];
  if (args['scaling'] !== undefined) patch.scaling = args['scaling'] as Scaling;
  if (Object.keys(patch).length > 0) {
    const r = actions.updateMapMeta(mapId, patch);
    if (!r.ok) return fail(r.error);
  }

  for (const slot of ['x', 'y'] as const) {
    const key = slot === 'x' ? 'xAxis' : 'yAxis';
    if (!(key in args)) continue;
    const value = args[key];
    const r = actions.setMapAxis(mapId, slot, value === null ? undefined : (value as AxisDef));
    if (!r.ok) return fail(r.error);
  }

  const map = get(maps).find((m) => m.id === mapId);
  return map === undefined ? fail(`no confirmed map with id ${mapId}`) : okv({ map });
}

function applyAxisEntryChange(args: Record<string, unknown>): DispatchResult {
  const create = args['create'];
  if (create !== undefined) {
    const c = asRecord(create);
    if (typeof c['name'] !== 'string') return fail('"create.name" is required');
    const r = actions.addAxisLibEntry(c['name'], c['axis'] as AxisDef, c['notes'] as string | undefined);
    return r.ok ? okv({ entry: r.value }) : fail(r.error);
  }
  const entryId = args['entryId'];
  if (typeof entryId !== 'string') return fail('"entryId" is required');

  if (args['remove'] === true) {
    const r = actions.removeAxisLibEntry(entryId);
    return r.removed
      ? okv({ removed: entryId, detached: r.detached })
      : fail(`no axis library entry with id ${entryId}`);
  }
  if (args['restamp'] === true) {
    const r = actions.restampAxisLibEntry(entryId);
    return okv({ updated: r.updated, skipped: r.skipped });
  }
  const patch: actions.AxisLibEntryPatch = {};
  if (typeof args['name'] === 'string') patch.name = args['name'];
  if (args['axis'] !== undefined) patch.axis = args['axis'] as AxisDef;
  if (typeof args['notes'] === 'string') patch.notes = args['notes'];
  const r = actions.updateAxisLibEntry(entryId, patch);
  return r.ok ? okv({ entry: r.value }) : fail(r.error);
}

/**
 * Accept the checked rows of a proposal as ONE undo step — the user decided
 * once, so one Ctrl+Z reverses it once (spec §6.2).
 */
export function applyProposal(
  requestId: string,
  acceptedIds: string[]
): { accepted: string[]; rejected: string[]; failed: Array<{ id: string; error: string }> } {
  const proposal = get(proposals).find((p) => p.requestId === requestId);
  proposals.update((ps) => ps.filter((p) => p.requestId !== requestId));
  if (proposal === undefined) return { accepted: [], rejected: [], failed: [] };

  const accepted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const wanted = new Set(acceptedIds);

  undoTransaction(`co-pilot: ${proposal.title}`, () => {
    for (const change of proposal.changes) {
      if (!wanted.has(change.id)) continue;
      const r = applyChange(kindOf(change), change);
      if (r.ok) accepted.push(change.id);
      else failed.push({ id: change.id, error: r.error });
    }
  });

  const rejected = proposal.changes.map((c) => c.id).filter((id) => !wanted.has(id));
  return { accepted, rejected, failed };
}

/** A change carries its op explicitly when escalated; otherwise infer from shape. */
function kindOf(change: Record<string, unknown>): string {
  if (typeof change['op'] === 'string') return change['op'];
  if (change['addMap'] !== undefined) return 'addMap';
  if (change['entryId'] !== undefined || change['create'] !== undefined) return 'change_axis_entry';
  return 'change_map';
}
