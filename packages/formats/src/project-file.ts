import type { AxisDef, AxisLibEntry, MapDef, Project, Result, Scaling, ValueFormat } from '@binanalyzer/core';
import { validateAxisLibEntry, validateMapDef } from '@binanalyzer/core';

/**
 * .binproj.json save/load (spec §3, §8): JSON with canonical key order,
 * schemaVersion 1|2 accepted (2 written, v1 normalized on load; anything newer
 * rejected with a clear message), bin referenced by name+sha256+size — never
 * embedded. parseProject guarantees the spec §8 invariant "a project that
 * loads is fully readable": every map passes validateMapDef against the
 * recorded size, maps[] carries only non-auto provenance, potentialMaps[] only
 * auto. Comparing the recorded sha256 against the actual bin bytes is the
 * app's job (it has the bytes). schemaVersion 2 is written unconditionally; v1
 * documents are accepted and normalized on load (2026-07-29 shared-axis-library
 * spec §3).
 */
export function serializeProject(project: Project): string {
  const canonical: Project = {
    schemaVersion: 3,
    bin: { name: project.bin.name, sha256: project.bin.sha256, size: project.bin.size },
    ...(project.derivedFrom !== undefined
      ? { derivedFrom: { name: project.derivedFrom.name, sha256: project.derivedFrom.sha256 } }
      : {}),
    valueDefaults: project.valueDefaults,
    ...(project.addressFrame !== undefined ? { addressFrame: project.addressFrame } : {}),
    ...(project.axisLibrary !== undefined && project.axisLibrary.length > 0 ? { axisLibrary: project.axisLibrary } : {}),
    maps: project.maps,
    potentialMaps: project.potentialMaps,
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function isValueFormat(v: unknown): v is ValueFormat {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Partial<ValueFormat>;
  return (
    (f.width === 1 || f.width === 2 || f.width === 4) &&
    typeof f.signed === 'boolean' &&
    (f.endianness === 'little' || f.endianness === 'big')
  );
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Nested-field gate for Scaling (spec §3) — every field validateMapDef and toPhysical assume is present and numeric/string-typed. */
function scalingShapeError(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null) return 'missing scaling';
  const s = v as Partial<Scaling>;
  if (!isFiniteNumber(s.factor)) return 'scaling.factor must be a number';
  if (!isFiniteNumber(s.offset)) return 'scaling.offset must be a number';
  if (typeof s.units !== 'string') return 'scaling.units must be a string';
  if (!isFiniteNumber(s.digits)) return 'scaling.digits must be a number';
  if (s.rawExpression !== undefined && typeof s.rawExpression !== 'string') {
    return 'scaling.rawExpression must be a string';
  }
  return undefined;
}

/**
 * Nested-field gate for AxisDef (spec §3). Malformed axis internals (e.g. a
 * non-numeric format.width) must be rejected here — core's axisError trusts
 * these fields to be numeric and compares them with plain `>`, which a NaN
 * silently passes (NaN > binSize is false).
 */
function axisShapeError(v: unknown, label: string): string | undefined {
  if (typeof v !== 'object' || v === null) return `${label} axis must be an object`;
  const a = v as Partial<AxisDef>;
  if (a.kind !== 'referenced' && a.kind !== 'literal' && a.kind !== 'index') {
    return `${label} axis has invalid kind`;
  }
  if (!isFiniteNumber(a.count)) return `${label} axis count must be a number`;
  if (a.address !== undefined && !isFiniteNumber(a.address)) return `${label} axis address must be a number`;
  if (a.format !== undefined && !isValueFormat(a.format)) return `${label} axis format is invalid`;
  if (a.kind === 'referenced' && (a.address === undefined || a.format === undefined)) {
    return `${label} referenced axis missing address/format`;
  }
  if (a.values !== undefined && (!Array.isArray(a.values) || !a.values.every(isFiniteNumber))) {
    return `${label} axis values must be an array of numbers`;
  }
  if (a.kind === 'literal' && a.values === undefined) return `${label} literal axis missing values`;
  if (a.scaling !== undefined) {
    const e = scalingShapeError(a.scaling);
    if (e) return `${label} axis ${e}`;
  }
  if (a.name !== undefined && typeof a.name !== 'string') return `${label} axis name must be a string`;
  if (a.libId !== undefined && typeof a.libId !== 'string') return `${label} axis libId must be a string when present`;
  return undefined;
}

/**
 * Nested-field gate for AxisLibEntry (2026-07-29 shared-axis-library spec §3)
 * — shape only; range/semantic rules live in core validateAxisLibEntry.
 */
function axisLibEntryShapeError(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null) return 'entry must be an object';
  const e = v as Partial<AxisLibEntry>;
  if (typeof e.id !== 'string') return 'entry id must be a string';
  if (typeof e.name !== 'string') return 'entry name must be a string';
  if (e.notes !== undefined && typeof e.notes !== 'string') return 'entry notes must be a string';
  return axisShapeError(e.axis, `entry "${e.name}"`);
}

/**
 * Nested-field gate for SwitchState[] (spec 2026-07-23). Malformed states
 * (e.g. a NaN or out-of-range byte) must be rejected here — core's
 * validateMapDef trusts these fields once shape-checked; this closes the same
 * NaN-bypass class axisShapeError exists for.
 */
function stateShapeError(states: unknown): string | undefined {
  if (!Array.isArray(states) || states.length === 0) return 'states must be a non-empty array';
  for (const entry of states) {
    if (typeof entry !== 'object' || entry === null) return 'states entries must be objects';
    const s = entry as Record<string, unknown>;
    if (typeof s['name'] !== 'string' || s['name'].length === 0) return 'state name must be a non-empty string';
    const data = s['data'];
    if (!Array.isArray(data) || data.length === 0 || !data.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255)) {
      return 'state data must be a non-empty array of integers in [0, 255]';
    }
  }
  return undefined;
}

/** Minimal structural gate so validateMapDef (typed for MapDef) cannot crash on garbage. */
function mapShapeError(m: unknown): string | undefined {
  if (typeof m !== 'object' || m === null) return 'not an object';
  const d = m as Partial<MapDef>;
  if (typeof d.id !== 'string' || typeof d.name !== 'string') return 'missing id/name';
  if (typeof d.address !== 'number' || typeof d.rows !== 'number' || typeof d.cols !== 'number') {
    return 'missing address/rows/cols';
  }
  if (!isValueFormat(d.format)) return 'invalid format';
  const scalingErr = scalingShapeError(d.scaling);
  if (scalingErr) return scalingErr;
  if (d.xAxis !== undefined) {
    const e = axisShapeError(d.xAxis, 'x');
    if (e) return e;
  }
  if (d.yAxis !== undefined) {
    const e = axisShapeError(d.yAxis, 'y');
    if (e) return e;
  }
  if (d.states !== undefined) {
    const e = stateShapeError(d.states);
    if (e !== undefined) return e;
  }
  if (d.orientation !== 'row-major' && d.orientation !== 'col-major') return 'invalid orientation';
  if (d.provenance !== 'auto' && d.provenance !== 'manual' && d.provenance !== 'imported') return 'invalid provenance';
  return undefined;
}

export function parseProject(json: string): Result<Project> {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (typeof doc !== 'object' || doc === null) return { ok: false, error: 'project must be a JSON object' };
  const p = doc as Partial<Project> & { schemaVersion?: unknown };
  if (p.schemaVersion !== 1 && p.schemaVersion !== 2 && p.schemaVersion !== 3) {
    return {
      ok: false,
      error: `unsupported schemaVersion ${JSON.stringify(p.schemaVersion)} — this build supports schemaVersion 1, 2 and 3`,
    };
  }
  if (typeof p.bin !== 'object' || p.bin === null) return { ok: false, error: 'bin must be an object' };
  const bin = p.bin;
  if (typeof bin.name !== 'string' || typeof bin.size !== 'number' || !Number.isInteger(bin.size) || bin.size < 0) {
    return { ok: false, error: 'bin must carry a name and an integer size' };
  }
  if (typeof bin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(bin.sha256)) {
    return { ok: false, error: 'bin.sha256 must be 64 lowercase hex chars' };
  }
  const lineage = (p as { derivedFrom?: unknown }).derivedFrom;
  let derivedFrom: { name: string; sha256: string } | undefined;
  if (lineage !== undefined) {
    if (typeof lineage !== 'object' || lineage === null || Array.isArray(lineage)) {
      return { ok: false, error: 'derivedFrom must be an object when present' };
    }
    const l = lineage as { name?: unknown; sha256?: unknown };
    if (typeof l.name !== 'string' || l.name === '') {
      return { ok: false, error: 'derivedFrom.name must be a non-empty string' };
    }
    if (typeof l.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(l.sha256)) {
      return { ok: false, error: 'derivedFrom.sha256 must be 64 lowercase hex chars' };
    }
    derivedFrom = { name: l.name, sha256: l.sha256 };
  }
  if (!isValueFormat(p.valueDefaults)) return { ok: false, error: 'valueDefaults must be a valid ValueFormat' };
  const frame = (p as { addressFrame?: unknown }).addressFrame;
  if (frame !== undefined && frame !== 'ms41full') {
    return { ok: false, error: `addressFrame must be 'ms41full' when present, got ${JSON.stringify(frame)}` };
  }
  const lib = (p as { axisLibrary?: unknown }).axisLibrary;
  let axisLibrary: AxisLibEntry[] | undefined;
  if (lib !== undefined) {
    if (!Array.isArray(lib)) return { ok: false, error: 'axisLibrary must be an array' };
    const entryIds = new Set<string>();
    for (const [i, rawEntry] of lib.entries()) {
      const shapeError = axisLibEntryShapeError(rawEntry);
      if (shapeError !== undefined) return { ok: false, error: `axisLibrary[${i}]: ${shapeError}` };
      const e = rawEntry as AxisLibEntry;
      const v = validateAxisLibEntry(e, bin.size);
      if (!v.ok) return { ok: false, error: `axisLibrary[${i}]: ${v.error}` };
      if (entryIds.has(e.id)) return { ok: false, error: `axisLibrary[${i}] ("${e.name}"): duplicate entry id ${JSON.stringify(e.id)}` };
      entryIds.add(e.id);
    }
    axisLibrary = lib as AxisLibEntry[];
  }
  if (!Array.isArray(p.maps) || !Array.isArray(p.potentialMaps)) {
    return { ok: false, error: 'maps and potentialMaps must be arrays' };
  }
  for (const [listName, list, wantAuto] of [
    ['maps', p.maps, false],
    ['potentialMaps', p.potentialMaps, true],
  ] as const) {
    for (const [i, entry] of list.entries()) {
      const shapeError = mapShapeError(entry);
      if (shapeError !== undefined) return { ok: false, error: `${listName}[${i}]: ${shapeError}` };
      const map = entry as MapDef;
      const v = validateMapDef(map, bin.size);
      if (!v.ok) return { ok: false, error: `${listName}[${i}] ("${map.name}"): ${v.error}` };
      if ((map.provenance === 'auto') !== wantAuto) {
        return { ok: false, error: `${listName}[${i}] ("${map.name}"): provenance ${map.provenance} not allowed in ${listName}` };
      }
    }
  }
  return {
    ok: true,
    value: {
      schemaVersion: 3,
      bin: { name: bin.name, sha256: bin.sha256, size: bin.size },
      ...(derivedFrom !== undefined ? { derivedFrom } : {}),
      valueDefaults: p.valueDefaults,
      ...(frame === 'ms41full' ? { addressFrame: 'ms41full' as const } : {}),
      ...(axisLibrary !== undefined && axisLibrary.length > 0 ? { axisLibrary } : {}),
      maps: p.maps as MapDef[],
      potentialMaps: p.potentialMaps as MapDef[],
    },
  };
}
