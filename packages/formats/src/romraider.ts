import { isSwitch, type AxisDef, type MapDef, type Result, type Scaling, type SwitchState, type ValueFormat } from '@binanalyzer/core';
import { digitsFromFormat, formatFromDigits, parseAffineExpression, renderAffineExpression, renderInverseExpression } from './expression.js';
import { parseXml, xmlEscape, type XmlElement } from './xml.js';

/**
 * RomRaider XML definition import/export (spec §6).
 * Import handles: <rom> with <table type="1D|2D|3D|Switch">, storageaddress (hex,
 * with/without 0x; sizex/sizey are DECIMAL), storagetype/endian → ValueFormat
 * (width-1 normalized to endianness 'little'; absent endian on multi-byte
 * defaults to 'big'), axis sub-tables ("X Axis"/"Y Axis" referenced,
 * "Static X/Y Axis" literal), <scaling expression=…> (accept `expr` alias) →
 * affine Scaling or rawExpression fallback, and (task 3.1d) multi-rom
 * documents with <rom base="…"> inheritance chains merged root→leaf.
 * Export emits a single self-contained <rom> (no base chains) that this importer round-trips deep-equal.
 * Pure: XML string in, MapDef[] + warnings out. Never throws — Result.
 */
export interface RomRaiderImport {
  romId: string;
  maps: MapDef[];
  warnings: string[];
}

const STORAGE_TYPES: Record<string, { width: 1 | 2 | 4; signed: boolean; float?: boolean }> = {
  uint8: { width: 1, signed: false },
  int8: { width: 1, signed: true },
  uint16: { width: 2, signed: false },
  int16: { width: 2, signed: true },
  uint32: { width: 4, signed: false },
  int32: { width: 4, signed: true },
  float: { width: 4, signed: false, float: true },
};

/** storagetype+endian attrs → ValueFormat; undefined when storagetype is absent/unknown. */
function parseValueFormat(attrs: Record<string, string>): ValueFormat | undefined {
  const st = attrs['storagetype'];
  if (st === undefined) return undefined;
  const base = STORAGE_TYPES[st.toLowerCase()];
  if (base === undefined) return undefined;
  // Width-1 endianness is meaningless — normalize to 'little' (canonical form,
  // matches the committed ms41 ground truth). Multi-byte default is BIG
  // (RomRaider convention); this def family always declares little explicitly.
  const endianness = base.width === 1 ? 'little' : attrs['endian'] === 'little' ? 'little' : 'big';
  const format: ValueFormat = { width: base.width, signed: base.signed, endianness };
  if (base.float === true) format.float = true;
  return format;
}

function parseHexAddress(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const hex = s.trim().replace(/^0x/i, '');
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return undefined;
  return Number.parseInt(hex, 16);
}

function parseDecimalSize(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10); // sizex/sizey are DECIMAL — never parse as hex
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function importScaling(el: XmlElement | undefined, warnings: string[], context: string): Scaling {
  if (el === undefined) return { factor: 1, offset: 0, units: '', digits: 0 };
  const units = el.attrs['units'] ?? '';
  const digits = digitsFromFormat(el.attrs['format']);
  const expression = el.attrs['expression'] ?? el.attrs['expr'];
  if (expression === undefined || expression.trim() === '') return { factor: 1, offset: 0, units, digits };
  const affine = parseAffineExpression(expression);
  if (affine === null) {
    warnings.push(`${context}: non-affine scaling ${JSON.stringify(expression)} preserved as rawExpression`);
    return { factor: 1, offset: 0, units, digits, rawExpression: expression };
  }
  return { factor: affine.factor, offset: affine.offset, units, digits };
}

type AxisRole = 'x' | 'y';

function axisRole(type: string | undefined): AxisRole | undefined {
  if (type === 'X Axis' || type === 'Static X Axis') return 'x';
  if (type === 'Y Axis' || type === 'Static Y Axis') return 'y';
  return undefined;
}

function importAxis(el: XmlElement, expectedCount: number, warnings: string[], context: string): AxisDef | undefined {
  const name = el.attrs['name'];
  const scalingEl = el.children.find((c) => c.name === 'scaling');
  const finish = (axis: AxisDef): AxisDef => {
    if (name !== undefined) axis.name = name;
    if (scalingEl !== undefined) axis.scaling = importScaling(scalingEl, warnings, context);
    return axis;
  };
  if ((el.attrs['type'] ?? '').startsWith('Static')) {
    const data = el.children.filter((c) => c.name === 'data').map((c) => c.text);
    const values = data.map((d) => Number.parseFloat(d));
    if (data.length === 0 || values.some((v) => Number.isNaN(v))) {
      warnings.push(`${context}: static axis has non-numeric data — using index axis`);
      return finish({ kind: 'index', count: expectedCount });
    }
    if (values.length !== expectedCount) {
      warnings.push(`${context}: static axis has ${values.length} values, expected ${expectedCount} — using index axis`);
      return finish({ kind: 'index', count: expectedCount });
    }
    return finish({ kind: 'literal', count: values.length, values });
  }
  const address = parseHexAddress(el.attrs['storageaddress']);
  if (address === undefined) {
    warnings.push(`${context}: referenced axis has no storageaddress — axis dropped`);
    return undefined;
  }
  let format = parseValueFormat(el.attrs);
  if (format === undefined) {
    if (el.attrs['storagetype'] !== undefined) {
      warnings.push(`${context}: unknown axis storagetype ${JSON.stringify(el.attrs['storagetype'])} — axis dropped`);
      return undefined;
    }
    warnings.push(`${context}: axis storagetype missing — defaulting to uint8`);
    format = { width: 1, signed: false, endianness: 'little' };
  }
  return finish({ kind: 'referenced', address, count: expectedCount, format });
}

type TableImport =
  | { kind: 'map'; map: Omit<MapDef, 'id'> }
  | { kind: 'no-address' }
  | { kind: 'unsupported-type'; type: string };

/** State-data token: one byte as 1-2 hex digits (real defs carry single-digit
 *  tokens, e.g. data="C" — a strict pairs-only grammar skips live tables). */
const STATE_TOKEN = /^[0-9A-Fa-f]{1,2}$/;

/**
 * RomRaider type="Switch" (spec 2026-07-23): size = sizey ?? sizex ?? 1
 * (DECIMAL) u8 bytes at storageaddress, plus named byte-pattern states.
 * Malformed states are dropped per-state (warning names table and state);
 * the table is skipped only when an ADDRESS is present but no well-formed
 * state remains — a stateless switch is undisplayable. (Address-less
 * switches take the no-address path first, like every table; the real def's
 * base-rom "Byte 6 - O2 Feedback" is one — its address AND states both
 * arrive via derived-rom overrides.)
 */
function importSwitchTable(el: XmlElement, name: string, warnings: string[]): TableImport {
  const address = parseHexAddress(el.attrs['storageaddress']);
  if (address === undefined) return { kind: 'no-address' };
  const size = parseDecimalSize(el.attrs['sizey']) ?? parseDecimalSize(el.attrs['sizex']) ?? 1;
  const states: SwitchState[] = [];
  for (const child of el.children) {
    if (child.name !== 'state') continue;
    const stateName = child.attrs['name'];
    const data = child.attrs['data'];
    if (stateName === undefined || stateName.length === 0 || data === undefined || data.trim().length === 0) {
      warnings.push(`table "${name}": state ${stateName !== undefined && stateName.length > 0 ? JSON.stringify(stateName) : '(unnamed)'} missing name/data — state dropped`);
      continue;
    }
    const tokens = data.trim().split(/\s+/);
    if (tokens.some((t) => !STATE_TOKEN.test(t))) {
      warnings.push(`table "${name}": state ${JSON.stringify(stateName)} has a non-hex-byte token — state dropped`);
      continue;
    }
    if (tokens.length !== size) {
      warnings.push(`table "${name}": state ${JSON.stringify(stateName)} has ${tokens.length} byte(s), expected ${size} — state dropped`);
      continue;
    }
    states.push({ name: stateName, data: tokens.map((t) => Number.parseInt(t, 16)) });
  }
  if (states.length === 0) {
    warnings.push(`table "${name}": switch has no well-formed states — skipped`);
    return { kind: 'no-address' }; // rides the existing skip counter, like the missing-storagetype path
  }
  const map: Omit<MapDef, 'id'> = {
    name,
    address,
    rows: size,
    cols: 1,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major',
    provenance: 'imported',
    states,
  };
  const category = el.attrs['category'];
  if (category !== undefined) map.category = category;
  const description = el.children.find((c) => c.name === 'description');
  if (description !== undefined && description.text.length > 0) map.notes = description.text;
  return { kind: 'map', map };
}

function importTable(el: XmlElement, warnings: string[]): TableImport {
  const name = el.attrs['name'] ?? '(unnamed)';
  const type = el.attrs['type'];
  if (type === 'Switch') return importSwitchTable(el, name, warnings);
  if (type !== '1D' && type !== '2D' && type !== '3D') return { kind: 'unsupported-type', type: type ?? '(none)' };
  const address = parseHexAddress(el.attrs['storageaddress']);
  if (address === undefined) return { kind: 'no-address' };
  const format = parseValueFormat(el.attrs);
  if (format === undefined) {
    warnings.push(`table "${name}": missing or unknown storagetype — skipped`);
    return { kind: 'no-address' };
  }
  const sizex = parseDecimalSize(el.attrs['sizex']);
  const sizey = parseDecimalSize(el.attrs['sizey']);
  let rows: number;
  let cols: number;
  if (type === '3D') {
    if (sizex === undefined || sizey === undefined) {
      warnings.push(`table "${name}": 3D table without sizex/sizey — skipped`);
      return { kind: 'no-address' };
    }
    cols = sizex; // sizex = COLUMNS, sizey = ROWS — the classic swap trap
    rows = sizey;
  } else if (type === '2D') {
    rows = sizey ?? 1;
    cols = sizex ?? 1;
  } else {
    rows = 1;
    cols = 1;
  }
  const scaling = importScaling(el.children.find((c) => c.name === 'scaling'), warnings, `table "${name}"`);
  const map: Omit<MapDef, 'id'> = { name, address, rows, cols, format, scaling, orientation: 'row-major', provenance: 'imported' };
  const category = el.attrs['category'];
  if (category !== undefined) map.category = category;
  const description = el.children.find((c) => c.name === 'description');
  if (description !== undefined && description.text.length > 0) map.notes = description.text;
  for (const child of el.children) {
    if (child.name !== 'table') continue;
    const role = axisRole(child.attrs['type']);
    if (role === undefined) continue;
    const axis = importAxis(child, role === 'x' ? cols : rows, warnings, `table "${name}" ${role}-axis`);
    if (axis === undefined) continue;
    if (role === 'x') map.xAxis = axis;
    else map.yAxis = axis;
  }
  return { kind: 'map', map };
}

function importTables(tableEls: XmlElement[], xmlid: string, warnings: string[]): MapDef[] {
  const maps: MapDef[] = [];
  const idCounts = new Map<string, number>();
  let noAddress = 0;
  const unsupported = new Map<string, number>();
  for (const el of tableEls) {
    const r = importTable(el, warnings);
    if (r.kind === 'no-address') {
      noAddress++;
      continue;
    }
    if (r.kind === 'unsupported-type') {
      unsupported.set(r.type, (unsupported.get(r.type) ?? 0) + 1);
      continue;
    }
    const baseId = `${xmlid}-0x${r.map.address.toString(16)}`.toLowerCase();
    const n = idCounts.get(baseId) ?? 0;
    idCounts.set(baseId, n + 1);
    maps.push({ ...r.map, id: n === 0 ? baseId : `${baseId}-${n + 1}` });
  }
  if (noAddress > 0) {
    warnings.push(`${noAddress} table(s) with no storageaddress for this rom — skipped (normal for shared-base defs)`);
  }
  for (const [t, c] of unsupported) warnings.push(`${c} table(s) of unsupported type ${JSON.stringify(t)} — skipped`);
  return maps;
}

interface RomEntry {
  xmlid: string;
  base: string | undefined;
  el: XmlElement;
}

function collectRoms(root: XmlElement): RomEntry[] {
  const romEls = root.name === 'rom' ? [root] : root.children.filter((c) => c.name === 'rom');
  return romEls.map((el) => {
    const romid = el.children.find((c) => c.name === 'romid');
    const xmlid = romid?.children.find((c) => c.name === 'xmlid')?.text ?? '';
    return { xmlid, base: el.attrs['base'], el };
  });
}

/**
 * Attribute-level merge of a base table element with a derived override
 * (most-derived wins). Children: axis sub-tables merge by ROLE (derived
 * overrides carry type="X Axis" + storageaddress and no name — merging by
 * name would detach them); <scaling>/<description> merge attribute-wise;
 * <data> lists replace wholesale when the override carries any; everything
 * else appends. <state> lists replace wholesale like <data> (real defs
 * REDEFINE state sets in derived roms — Byte 6 - O2 Feedback, AlphaN).
 */
function mergeElements(base: XmlElement, override: XmlElement): XmlElement {
  const merged: XmlElement = {
    name: base.name,
    attrs: { ...base.attrs, ...override.attrs },
    children: [],
    text: override.text.length > 0 ? override.text : base.text,
  };
  const overrideAxes = new Map<AxisRole, XmlElement>();
  for (const oc of override.children) {
    if (oc.name === 'table') {
      const role = axisRole(oc.attrs['type']);
      if (role !== undefined && !overrideAxes.has(role)) overrideAxes.set(role, oc);
    }
  }
  const consumed = new Set<XmlElement>();
  const overrideData = override.children.filter((c) => c.name === 'data');
  for (const d of overrideData) consumed.add(d);
  const overrideStates = override.children.filter((c) => c.name === 'state');
  for (const s of overrideStates) consumed.add(s);
  const isSingleton = (n: string) => n === 'scaling' || n === 'description';
  for (const bc of base.children) {
    if (bc.name === 'data') continue; // re-emitted below from whichever side wins
    if (bc.name === 'state') continue; // re-emitted below from whichever side wins
    if (bc.name === 'table') {
      const role = axisRole(bc.attrs['type']);
      const oc = role !== undefined ? overrideAxes.get(role) : undefined;
      if (oc !== undefined && !consumed.has(oc)) {
        merged.children.push(mergeElements(bc, oc));
        consumed.add(oc);
        continue;
      }
      merged.children.push(bc);
      continue;
    }
    if (isSingleton(bc.name)) {
      const oc = override.children.find((c) => c.name === bc.name && !consumed.has(c));
      if (oc !== undefined) {
        merged.children.push(mergeElements(bc, oc));
        consumed.add(oc);
        continue;
      }
    }
    merged.children.push(bc);
  }
  merged.children.push(...(overrideData.length > 0 ? overrideData : base.children.filter((c) => c.name === 'data')));
  merged.children.push(...(overrideStates.length > 0 ? overrideStates : base.children.filter((c) => c.name === 'state')));
  for (const oc of override.children) {
    if (!consumed.has(oc) && !merged.children.includes(oc)) merged.children.push(oc);
  }
  return merged;
}

/** Walk base="…" references root→leaf. Tolerant: missing base or a cycle truncates with a warning. */
function chainFor(entry: RomEntry, all: RomEntry[], warnings: string[]): XmlElement[] {
  const chain: RomEntry[] = [entry];
  const seen = new Set<RomEntry>([entry]);
  let cur = entry;
  while (cur.base !== undefined) {
    const parent = all.find((r) => r.xmlid === cur.base);
    if (parent === undefined) {
      warnings.push(`rom "${entry.xmlid}": base "${cur.base}" not found — chain truncated`);
      break;
    }
    if (seen.has(parent)) {
      warnings.push(`rom "${entry.xmlid}": inheritance cycle at "${parent.xmlid}" — chain truncated`);
      break;
    }
    seen.add(parent);
    chain.push(parent);
    cur = parent;
  }
  return chain.reverse().map((r) => r.el);
}

/** Merge every <table> by NAME along the chain (Map preserves first-appearance order = base document order). */
function resolveRomTables(chain: XmlElement[]): XmlElement[] {
  const tables = new Map<string, XmlElement>();
  for (const rom of chain) {
    for (const t of rom.children) {
      if (t.name !== 'table') continue;
      const name = t.attrs['name'];
      if (name === undefined) continue;
      if (t.attrs['omit'] === 'true') {
        tables.delete(name);
        continue;
      }
      const existing = tables.get(name);
      tables.set(name, existing === undefined ? t : mergeElements(existing, t));
    }
  }
  return [...tables.values()];
}

export function importRomRaiderXml(xml: string, romId?: string): Result<RomRaiderImport> {
  const parsed = parseXml(xml);
  if (!parsed.ok) return parsed;
  const root = parsed.value;
  if (root.name !== 'roms' && root.name !== 'rom') {
    return { ok: false, error: `expected <roms> or <rom> root element, got <${root.name}>` };
  }
  const roms = collectRoms(root);
  if (roms.length === 0) return { ok: false, error: 'no <rom> elements found' };
  const available = [...new Set(roms.map((r) => r.xmlid))].join(', ');
  let candidates: RomEntry[];
  if (romId === undefined) {
    if (roms.length > 1) {
      return { ok: false, error: `definition contains ${roms.length} roms — pass a romId; available: ${available}` };
    }
    candidates = roms;
  } else {
    candidates = roms.filter((r) => r.xmlid === romId);
    if (candidates.length === 0) return { ok: false, error: `rom "${romId}" not found; available: ${available}` };
  }
  const warnings: string[] = [];
  // Several roms may share one xmlid (24KB CAL vs 256KB full-read framings of
  // the same CAL-ID) — pick the candidate whose chain imports the most maps
  // (ties: first in document order). Matches ms41def.py and the committed GT.
  let best: { maps: MapDef[]; warnings: string[] } | undefined;
  for (const candidate of candidates) {
    const w: string[] = [];
    const maps = importTables(resolveRomTables(chainFor(candidate, roms, w)), candidate.xmlid, w);
    if (best === undefined || maps.length > best.maps.length) best = { maps, warnings: w };
  }
  if (candidates.length > 1) {
    warnings.push(`${candidates.length} roms share xmlid "${candidates[0]!.xmlid}" — picked the variant importing the most maps`);
  }
  warnings.push(...best!.warnings);
  return { ok: true, value: { romId: candidates[0]!.xmlid, maps: best!.maps, warnings } };
}

export interface RomRaiderExportOptions {
  /** RomRaider auto-matches a def by reading internalidstring at this address. */
  internalIdAddress?: number;
  internalIdString?: string;
}

function storageTypeName(format: ValueFormat): string {
  if (format.float === true) return 'float';
  return `${format.signed ? 'int' : 'uint'}${format.width * 8}`;
}

function hexAttr(n: number): string {
  return n.toString(16).toUpperCase();
}

function scalingLine(scaling: Scaling, indent: string): string {
  const expression = scaling.rawExpression ?? renderAffineExpression(scaling.factor, scaling.offset, 'x');
  const toByte = scaling.rawExpression === undefined ? renderInverseExpression(scaling.factor, scaling.offset, 'x') : null;
  let s = `${indent}<scaling units="${xmlEscape(scaling.units)}" expression="${xmlEscape(expression)}"`;
  if (toByte !== null) s += ` to_byte="${xmlEscape(toByte)}"`;
  return `${s} format="${formatFromDigits(scaling.digits)}" />`;
}

/** Emit one axis sub-table; returns an error string instead of emitting on invalid input. */
function axisLines(role: 'X' | 'Y', axis: AxisDef, mapName: string, lines: string[]): string | undefined {
  if (axis.kind === 'index') return undefined; // no RomRaider representation; carries no information
  const nameAttr = axis.name !== undefined ? ` name="${xmlEscape(axis.name)}"` : '';
  if (axis.kind === 'literal') {
    if (axis.values === undefined || axis.values.length !== axis.count) {
      return `map "${mapName}": literal ${role} axis without ${axis.count} values`;
    }
    lines.push(`    <table type="Static ${role} Axis"${nameAttr}>`);
    for (const v of axis.values) lines.push(`      <data>${String(v)}</data>`);
    if (axis.scaling !== undefined) lines.push(scalingLine(axis.scaling, '      '));
    lines.push('    </table>');
    return undefined;
  }
  if (axis.address === undefined || axis.format === undefined) {
    return `map "${mapName}": referenced ${role} axis is missing address/format`;
  }
  const attrs = [`type="${role} Axis"`];
  if (axis.name !== undefined) attrs.push(`name="${xmlEscape(axis.name)}"`);
  attrs.push(`storagetype="${storageTypeName(axis.format)}"`);
  if (axis.format.width > 1) attrs.push(`endian="${axis.format.endianness}"`);
  attrs.push(`storageaddress="${hexAttr(axis.address)}"`);
  if (axis.scaling !== undefined) {
    lines.push(`    <table ${attrs.join(' ')}>`);
    lines.push(scalingLine(axis.scaling, '      '));
    lines.push('    </table>');
  } else {
    lines.push(`    <table ${attrs.join(' ')} />`);
  }
  return undefined;
}

/**
 * MapDef.id and AxisDef.libId are not persisted — RomRaider has neither
 * concept; re-importing regenerates importer-convention ids and yields
 * unstamped axes (round-trip is deep-equal modulo libId).
 */
export function exportRomRaiderXml(romId: string, maps: MapDef[], options: RomRaiderExportOptions = {}): Result<string> {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<roms>',
    '<rom>',
    '  <romid>',
    `    <xmlid>${xmlEscape(romId)}</xmlid>`,
    `    <internalidaddress>${hexAttr(options.internalIdAddress ?? 0)}</internalidaddress>`,
    `    <internalidstring>${xmlEscape(options.internalIdString ?? romId)}</internalidstring>`,
    '  </romid>',
  ];
  for (const map of maps) {
    if (map.orientation !== 'row-major') {
      return { ok: false, error: `map "${map.name}": col-major export is not supported in v1` };
    }
    if (isSwitch(map)) {
      const states = map.states ?? []; // narrowing only — isSwitch already guarantees states is defined
      const attrs = [`type="Switch"`, `name="${xmlEscape(map.name)}"`];
      if (map.category !== undefined) attrs.push(`category="${xmlEscape(map.category)}"`);
      attrs.push(`sizey="${map.rows}"`); // N = rows (spec); always emitted, decimal
      attrs.push(`storageaddress="${hexAttr(map.address)}"`);
      lines.push(`  <table ${attrs.join(' ')}>`);
      for (const s of states) {
        const data = s.data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        lines.push(`    <state name="${xmlEscape(s.name)}" data="${data}" />`);
      }
      if (map.notes !== undefined) lines.push(`    <description>${xmlEscape(map.notes)}</description>`);
      lines.push('  </table>');
      continue; // switches carry no scaling/axes — skip the grid path
    }
    const type = map.rows > 1 && map.cols > 1 ? '3D' : '2D';
    const attrs = [`type="${type}"`, `name="${xmlEscape(map.name)}"`];
    if (map.category !== undefined) attrs.push(`category="${xmlEscape(map.category)}"`);
    attrs.push(`storagetype="${storageTypeName(map.format)}"`);
    if (map.format.width > 1) attrs.push(`endian="${map.format.endianness}"`);
    if (type === '3D' || map.cols > 1) attrs.push(`sizex="${map.cols}"`);
    if (type === '3D' || map.rows > 1 || map.cols === 1) attrs.push(`sizey="${map.rows}"`);
    attrs.push(`storageaddress="${hexAttr(map.address)}"`);
    lines.push(`  <table ${attrs.join(' ')}>`);
    lines.push(scalingLine(map.scaling, '    '));
    for (const [role, axis] of [['X', map.xAxis], ['Y', map.yAxis]] as const) {
      if (axis === undefined) continue;
      const err = axisLines(role, axis, map.name, lines);
      if (err !== undefined) return { ok: false, error: err };
    }
    if (map.notes !== undefined) lines.push(`    <description>${xmlEscape(map.notes)}</description>`);
    lines.push('  </table>');
  }
  lines.push('</rom>', '</roms>');
  return { ok: true, value: lines.join('\n') + '\n' };
}
