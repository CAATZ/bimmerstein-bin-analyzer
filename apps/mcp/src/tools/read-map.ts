import { matchSwitchState, readGrid, toPhysical, validateMapDef, type MapDef, type Scaling, type ValueFormat } from '@binanalyzer/core';
import { MCP_CONFIG } from '../config.js';
import { asArgs, optEnum, reqString } from '../args.js';
import { axisView } from '../axisview.js';
import { mapKind } from '../kind.js';
import { findMap } from '../maps.js';
import { err, ok, unknownBin, type ToolSpec } from '../result.js';

const IDENTITY: Scaling = { factor: 1, offset: 0, units: '', digits: 0 };

const VALUE_FORMAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['width'],
  properties: {
    width: { enum: [1, 2, 4] },
    signed: { type: 'boolean', default: false },
    endianness: { enum: ['little', 'big'], default: 'big' },
    float: { type: 'boolean', description: 'width 4 IEEE754 only' },
  },
} as const;

const SCALING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    factor: { type: 'number', default: 1 },
    offset: { type: 'number', default: 0 },
    units: { type: 'string', default: '' },
    digits: { type: 'integer', default: 0 },
  },
} as const;

function parseFormat(v: unknown): { ok: true; value: ValueFormat } | { ok: false; error: string } {
  if (typeof v !== 'object' || v === null) return { ok: false, error: '"map.format" is required — a wrong silent default decodes to plausible-looking garbage' };
  const o = v as Record<string, unknown>;
  const width = o['width'];
  if (width !== 1 && width !== 2 && width !== 4) return { ok: false, error: '"map.format.width" must be 1, 2 or 4' };
  const signed = o['signed'] ?? false;
  if (typeof signed !== 'boolean') return { ok: false, error: '"map.format.signed" must be a boolean' };
  const endianness = o['endianness'] ?? 'big';
  if (endianness !== 'little' && endianness !== 'big') return { ok: false, error: '"map.format.endianness" must be "little" or "big"' };
  const float = o['float'];
  if (float !== undefined && typeof float !== 'boolean') return { ok: false, error: '"map.format.float" must be a boolean' };
  if (float === true && width !== 4) return { ok: false, error: '"map.format.float" requires width 4' };
  return { ok: true, value: { width, signed, endianness, ...(float === true ? { float: true } : {}) } };
}

function parseScaling(v: unknown): { ok: true; value: Scaling } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: { ...IDENTITY } };
  if (typeof v !== 'object' || v === null) return { ok: false, error: '"map.scaling" must be an object' };
  const o = v as Record<string, unknown>;
  for (const key of ['factor', 'offset', 'digits'] as const) {
    if (o[key] !== undefined && typeof o[key] !== 'number') return { ok: false, error: `"map.scaling.${key}" must be a number` };
  }
  if (o['units'] !== undefined && typeof o['units'] !== 'string') return { ok: false, error: '"map.scaling.units" must be a string' };
  return {
    ok: true,
    value: {
      factor: (o['factor'] as number | undefined) ?? 1,
      offset: (o['offset'] as number | undefined) ?? 0,
      units: (o['units'] as string | undefined) ?? '',
      digits: (o['digits'] as number | undefined) ?? 0,
    },
  };
}

/** Build an ad-hoc MapDef from the `map` argument. */
function parseAdhoc(v: unknown): { ok: true; value: MapDef } | { ok: false; error: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: '"map" must be an object' };
  const o = v as Record<string, unknown>;
  const rawAddress = o['address'];
  const address =
    typeof rawAddress === 'number'
      ? rawAddress
      : typeof rawAddress === 'string' && /^0x[0-9a-f]+$/i.test(rawAddress.trim())
        ? Number.parseInt(rawAddress.trim(), 16)
        : typeof rawAddress === 'string' && /^[0-9]+$/.test(rawAddress.trim())
          ? Number.parseInt(rawAddress.trim(), 10)
          : Number.NaN;
  if (!Number.isInteger(address) || address < 0) return { ok: false, error: '"map.address" must be a non-negative integer or a 0x-hex string' };
  const rows = o['rows'];
  const cols = o['cols'];
  if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1) return { ok: false, error: '"map.rows" must be an integer >= 1' };
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1) return { ok: false, error: '"map.cols" must be an integer >= 1' };
  const format = parseFormat(o['format']);
  if (!format.ok) return format;
  const scaling = parseScaling(o['scaling']);
  if (!scaling.ok) return scaling;
  const orientation = o['orientation'] ?? 'row-major';
  if (orientation !== 'row-major' && orientation !== 'col-major') return { ok: false, error: '"map.orientation" must be "row-major" or "col-major"' };
  return {
    ok: true,
    value: {
      id: `adhoc-0x${address.toString(16)}-${rows}x${cols}w${format.value.width}`,
      name: `ad-hoc 0x${address.toString(16)}`,
      address,
      rows,
      cols,
      format: format.value,
      scaling: scaling.value,
      orientation,
      // 'manual' (not 'auto'): validateMapDef requires a confidence on auto maps.
      provenance: 'manual',
    },
  };
}

export const readMapTool: ToolSpec = {
  name: 'read_map',
  description:
    'Decode a map to values — physical through its scaling, or raw. Pass mapId for a detected/imported map, OR pass an ad-hoc `map` definition to probe an arbitrary address with no detection behind it. `map.format` is REQUIRED for the ad-hoc form on purpose: a wrong silent default decodes to plausible-looking garbage. Ad-hoc definitions are bounds-checked by the same validator the desktop app uses.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['binId'],
    properties: {
      binId: { type: 'string', description: 'sha256 handle from open_bin.' },
      mapId: { type: 'string', description: 'An id from list_maps. Exactly one of mapId / map.' },
      map: {
        type: 'object',
        additionalProperties: false,
        required: ['address', 'rows', 'cols', 'format'],
        description: 'Ad-hoc definition at an arbitrary file offset. Exactly one of mapId / map.',
        properties: {
          address: { type: ['integer', 'string'], description: 'File offset; integer or 0x-hex string.' },
          rows: { type: 'integer', minimum: 1 },
          cols: { type: 'integer', minimum: 1 },
          format: VALUE_FORMAT_SCHEMA,
          scaling: { ...SCALING_SCHEMA, description: 'Defaults to identity, which makes physical == raw.' },
          orientation: { enum: ['row-major', 'col-major'], default: 'row-major' },
        },
      },
      values: { enum: ['physical', 'raw', 'both'], default: 'physical' },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const id = reqString(a, 'binId');
    if (!id.ok) return err(id.error);
    const mode = optEnum(a, 'values', ['physical', 'raw', 'both'] as const, 'physical');
    if (!mode.ok) return err(mode.error);

    const hasMapId = a['mapId'] !== undefined;
    const hasAdhoc = a['map'] !== undefined;
    if (hasMapId === hasAdhoc) return err('provide exactly one of "mapId" (a detected/imported map) or "map" (an ad-hoc definition)');

    const entry = await deps.store.get(id.value);
    if (entry === undefined) return await unknownBin(deps, id.value);

    let map: MapDef;
    let source: string;
    if (hasMapId) {
      const mapId = reqString(a, 'mapId');
      if (!mapId.ok) return err(mapId.error);
      const found = findMap(entry, mapId.value);
      if (found === undefined) {
        const potential = entry.scan?.result.potentialMaps.length ?? 0;
        const imported = entry.imported?.maps.length ?? 0;
        return err(`unknown mapId "${mapId.value}" on bin "${entry.name}" (${potential} potential, ${imported} imported). Use list_maps to find an id.`);
      }
      map = found.map;
      source = found.source;
    } else {
      const parsed = parseAdhoc(a['map']);
      if (!parsed.ok) return err(parsed.error);
      map = parsed.value;
      source = 'adhoc';
    }

    const cells = map.rows * map.cols;
    if (cells > MCP_CONFIG.readMapMaxCells) {
      return err(`${map.rows}x${map.cols} is ${cells} cells; read_map caps a single call at ${MCP_CONFIG.readMapMaxCells}`);
    }
    const valid = validateMapDef(map, entry.size);
    if (!valid.ok) return err(valid.error);

    let rawGrid: number[][];
    try {
      rawGrid = readGrid(entry.bytes, map);
    } catch (e) {
      return err(`decode failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const physical = rawGrid.map((row) => row.map((v) => toPhysical(v, map.scaling)));

    const body: Record<string, unknown> = {
      binId: entry.binId,
      source,
      mapId: map.id,
      name: map.name,
      address: map.address,
      rows: map.rows,
      cols: map.cols,
      format: map.format,
      scaling: map.scaling,
      orientation: map.orientation,
      kind: mapKind(map),
      cells,
      values: mode.value === 'raw' ? rawGrid : physical,
    };
    if (mode.value === 'both') body['raw'] = rawGrid;
    if (map.xAxis !== undefined) body['xAxis'] = axisView(entry.bytes, map.xAxis, 'x', entry.isFullRead);
    if (map.yAxis !== undefined) body['yAxis'] = axisView(entry.bytes, map.yAxis, 'y', entry.isFullRead);
    if (map.states !== undefined) {
      const matched = matchSwitchState(entry.bytes, map);
      body['states'] = { defined: map.states.map((s) => s.name), actual: matched.actual, matched: matched.matched ?? null };
    }
    return ok(body);
  },
};
