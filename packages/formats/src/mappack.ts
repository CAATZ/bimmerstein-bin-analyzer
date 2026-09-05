import type { Result, Scaling, ValueFormat } from '@binanalyzer/core';
import { isValueFormat } from '@binanalyzer/core';

/** One table's worth of a tune: what to write, and what the author started from. */
export interface PackTable {
  name: string;
  /** In `MapPack.source.addressFrame`. */
  address: number;
  rows: number;
  cols: number;
  orientation: 'row-major' | 'col-major';
  format: ValueFormat;
  /** Display only — values are RAW and are never converted through this. */
  scaling: Scaling;
  /** RAW values to write, [row][col]. */
  values: number[][];
  /** RAW values the author's image held BEFORE they edited it, [row][col]. */
  baseline: number[][];
}

/**
 * A shareable tune, bound to a calibration identity.
 *
 * Applies only to a bin of the same `source.calId`: within a CAL-ID an address
 * is exact (0-4 % of tables move), across one 72-97 % of tables relocate, which
 * is why the gate is a hard equality and not a warning.
 */
export interface MapPack {
  schemaVersion: 1;
  source: {
    /**
     * Deliberately a plain string and not core's `FamilyId` union: a pack
     * naming a family this build does not know must PARSE, and then be refused
     * by the CAL-ID gate with a message that says so — not die in the parser
     * with a shape error that tells the user nothing.
     */
    familyId: string;
    /** Read from the image, never entered by hand. */
    calId: string;
    /** Provenance of the image the pack was built from. */
    binSha256: string;
    addressFrame?: 'ms41full';
  };
  title: string;
  notes?: string;
  tables: PackTable[];
}

/**
 * Canonical text: fixed key order, 2-space indent, trailing newline. Rebuilding
 * the object field by field rather than stringifying the input is what makes
 * serialize(parse(x)) === x, so a pack round-trips through the app without its
 * text shifting.
 */
export function serializePack(pack: MapPack): string {
  const canonical: MapPack = {
    schemaVersion: 1,
    source: {
      familyId: pack.source.familyId,
      calId: pack.source.calId,
      binSha256: pack.source.binSha256,
      ...(pack.source.addressFrame !== undefined ? { addressFrame: pack.source.addressFrame } : {}),
    },
    title: pack.title,
    ...(pack.notes !== undefined && pack.notes !== '' ? { notes: pack.notes } : {}),
    tables: pack.tables.map((t) => ({
      name: t.name,
      address: t.address,
      rows: t.rows,
      cols: t.cols,
      orientation: t.orientation,
      format: t.format,
      scaling: t.scaling,
      values: t.values,
      baseline: t.baseline,
    })),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

const isScaling = (v: unknown): v is Scaling => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<Scaling>;
  return (
    typeof s.factor === 'number' &&
    Number.isFinite(s.factor) &&
    typeof s.offset === 'number' &&
    Number.isFinite(s.offset) &&
    typeof s.units === 'string' &&
    typeof s.digits === 'number' &&
    Number.isInteger(s.digits) && s.digits >= 0 && s.digits <= 100
  );
};

/** A rows x cols grid of finite numbers, or a reason it is not one. */
function gridError(v: unknown, rows: number, cols: number, what: string): string | undefined {
  if (!Array.isArray(v) || v.length !== rows) return `${what} must have ${rows} rows`;
  for (const [i, row] of v.entries()) {
    if (!Array.isArray(row) || row.length !== cols) return `${what}[${i}] must have ${cols} columns`;
    for (const [j, cell] of row.entries()) {
      if (typeof cell !== 'number' || !Number.isFinite(cell)) {
        return `${what}[${i}][${j}] must be a finite number`;
      }
    }
  }
  return undefined;
}

function tableError(v: unknown, i: number): string | undefined {
  const at = `tables[${i}]`;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${at} must be an object`;
  const t = v as Partial<PackTable>;
  if (typeof t.name !== 'string' || t.name === '') return `${at}.name must be a non-empty string`;
  if (typeof t.address !== 'number' || !Number.isInteger(t.address) || t.address < 0) {
    return `${at}.address must be a non-negative integer`;
  }
  if (typeof t.rows !== 'number' || !Number.isInteger(t.rows) || t.rows < 1) {
    return `${at}.rows must be an integer >= 1`;
  }
  if (typeof t.cols !== 'number' || !Number.isInteger(t.cols) || t.cols < 1) {
    return `${at}.cols must be an integer >= 1`;
  }
  if (t.orientation !== 'row-major' && t.orientation !== 'col-major') {
    return `${at}.orientation must be "row-major" or "col-major"`;
  }
  if (!isValueFormat(t.format)) return `${at}.format must be a valid ValueFormat`;
  if (!isScaling(t.scaling)) return `${at}.scaling must be a valid Scaling`;
  return (
    gridError(t.values, t.rows, t.cols, `${at}.values`) ??
    gridError(t.baseline, t.rows, t.cols, `${at}.baseline`)
  );
}

/**
 * Parse and fully validate. Every rejection names the offending field, because
 * the person holding a broken pack is usually not the person who wrote it.
 */
export function parsePack(json: string): Result<MapPack> {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, error: 'a pack must be a JSON object' };
  }
  const p = doc as Partial<MapPack> & { schemaVersion?: unknown };
  if (p.schemaVersion !== 1) {
    return {
      ok: false,
      error: `unsupported schemaVersion ${JSON.stringify(p.schemaVersion)} — this build supports schemaVersion 1`,
    };
  }
  if (typeof p.source !== 'object' || p.source === null || Array.isArray(p.source)) {
    return { ok: false, error: 'source must be an object' };
  }
  const s = p.source;
  if (typeof s.familyId !== 'string' || s.familyId === '') {
    return { ok: false, error: 'source.familyId is required' };
  }
  if (typeof s.calId !== 'string' || s.calId === '') {
    return { ok: false, error: 'source.calId is required' };
  }
  if (typeof s.binSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.binSha256)) {
    return { ok: false, error: 'source.binSha256 must be 64 lowercase hex chars' };
  }
  if (s.addressFrame !== undefined && s.addressFrame !== 'ms41full') {
    return {
      ok: false,
      error: `source.addressFrame must be 'ms41full' when present, got ${JSON.stringify(s.addressFrame)}`,
    };
  }
  if (typeof p.title !== 'string' || p.title === '') return { ok: false, error: 'title is required' };
  if (p.notes !== undefined && typeof p.notes !== 'string') {
    return { ok: false, error: 'notes must be a string' };
  }
  if (!Array.isArray(p.tables) || p.tables.length === 0) {
    return { ok: false, error: 'tables must be a non-empty array' };
  }
  for (const [i, t] of p.tables.entries()) {
    const e = tableError(t, i);
    if (e !== undefined) return { ok: false, error: e };
  }
  return { ok: true, value: p as MapPack };
}
