import { asArgs, optAddress, optInt, optOneOf, reqAddress, reqString, optString } from '../args.js';
import { err, ok, requireLink, type Deps, type ToolResult, type ToolSpec } from '../result.js';

const VIEW_MODES = ['hex', '2d', '3d', 'map'] as const;

/**
 * Point ops are ungated: they do exactly what a click does and are reversed by
 * clicking elsewhere, so they are NOT on the undo stack. The app is the
 * authority — we report what it applied, not what we asked for.
 */
async function forward(deps: Deps, op: string, args: Record<string, unknown>): Promise<ToolResult> {
  const link = requireLink(deps);
  if (!link.ok) return err(link.error);
  const answer = await link.value.request<Record<string, unknown>>(op, args);
  if (!answer.ok) return err(answer.error);
  return ok({ ok: true, ...answer.value });
}

export const selectTool: ToolSpec = {
  name: 'select',
  description:
    "Select a byte range in the user's window, or select one map by id. This is exactly what their own click would do — it changes nothing and is undone by them clicking elsewhere. Use it to point at what you are talking about.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      address: { type: ['integer', 'string'], description: 'File offset of the first byte; integer or 0x-hex string.' },
      length: { type: 'integer', minimum: 1, description: 'Bytes to select. Defaults to 1.' },
      cols: { type: 'integer', minimum: 1, description: 'Column count to snap the selection to.' },
      mapId: { type: 'string', description: 'Select this map instead. Mutually exclusive with address/length.' },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const mapId = optString(a, 'mapId');
    if (!mapId.ok) return err(mapId.error);
    const hasRange = a['address'] !== undefined;
    if ((mapId.value !== undefined) === hasRange) {
      return err('provide exactly one of "mapId" (select a known map) or "address" (+ optional "length"/"cols")');
    }
    if (mapId.value !== undefined) return forward(deps, 'select', { mapId: mapId.value });

    const address = reqAddress(a, 'address');
    if (!address.ok) return err(address.error);
    const length = optInt(a, 'length', 1, 1, Number.MAX_SAFE_INTEGER);
    if (!length.ok) return err(length.error);
    const args: Record<string, unknown> = { address: address.value, length: length.value };
    if (a['cols'] !== undefined) {
      const cols = optInt(a, 'cols', 1, 1, 4096);
      if (!cols.ok) return err(cols.error);
      args['cols'] = cols.value;
    }
    return forward(deps, 'select', args);
  },
};

export const showTool: ToolSpec = {
  name: 'show',
  description:
    "Move the user's view: jump to an address, switch the view mode, or both. Harmless and reversible by them — it changes no data.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      address: { type: ['integer', 'string'], description: 'File offset to bring into view.' },
      viewMode: { enum: [...VIEW_MODES], description: 'hex dump, 2D graph, 3D surface, or the map table.' },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const args: Record<string, unknown> = {};
    const address = optAddress(a, 'address');
    if (!address.ok) return err(address.error);
    if (address.value !== undefined) args['address'] = address.value;

    const mode = optOneOf(a, 'viewMode', VIEW_MODES);
    if (!mode.ok) return err(mode.error);
    if (mode.value !== undefined) args['viewMode'] = mode.value;

    if (Object.keys(args).length === 0) return err('provide at least one of "address" or "viewMode"');
    return forward(deps, 'show', args);
  },
};

export const openMapTool: ToolSpec = {
  name: 'open_map',
  description:
    'Select a map AND switch the user to the view that suits its shape (3D for a grid, the curve chart for a 1D table). The one-call "show me this table".',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['mapId'],
    properties: { mapId: { type: 'string', description: 'A confirmed map, or one of your own detections.' } },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const mapId = reqString(a, 'mapId');
    if (!mapId.ok) return err(mapId.error);
    return forward(deps, 'open_map', { mapId: mapId.value });
  },
};
