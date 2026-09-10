import { isParamShaped, isSwitch, type AxisDef, type MapDef, type Result } from '@binanalyzer/core';

/**
 * CSV/JSON map-list export (spec §6). FROZEN header (single authority, keep
 * in sync with spec §6):
 * name,category,address,rows,cols,width,signed,endian,factor,offset,units,
 * digits,xAxisAddress,xAxisCount,yAxisAddress,yAxisCount,confidence,provenance,
 * detector,kind
 * (`detector` — the detection tier, family|structural|pool|generic — and
 * `kind` — 'switch' for states-bearing maps, 'param' for 1×1 stateless maps,
 * empty/null otherwise (curves stay implicit today; a future 'curve' value
 * must be possible without another column change) — were each APPENDED after
 * the original frozen
 * prefix; the frozen column order up to `provenance` is unchanged,
 * so older consumers keep working.)
 * Cell semantics: addresses 0x-prefixed LOWERCASE hex; axis columns filled
 * only for referenced axes (literal/index axes have no address — cells stay
 * empty); confidence + detector only for auto maps; RFC 4180 quoting; LF + trailing
 * newline; JSON = the same records as an object array, null for empty cells.
 * Non-affine scalings emit their neutral factor/offset (raw display) — the
 * frozen header has no rawExpression column. float-ness is not representable
 * either; this format has no float-storage flag.
 */
export interface MapListRecord {
  name: string;
  category: string | null;
  address: string;
  rows: number;
  cols: number;
  width: number;
  signed: boolean;
  endian: 'little' | 'big';
  factor: number;
  offset: number;
  units: string;
  digits: number;
  xAxisAddress: string | null;
  xAxisCount: number | null;
  yAxisAddress: string | null;
  yAxisCount: number | null;
  confidence: number | null;
  provenance: string;
  detector: string | null;
  kind: 'switch' | 'param' | null;
}

const CSV_HEADER =
  'name,category,address,rows,cols,width,signed,endian,factor,offset,units,digits,xAxisAddress,xAxisCount,yAxisAddress,yAxisCount,confidence,provenance,detector,kind';

function hex(n: number): string {
  return `0x${n.toString(16).toLowerCase()}`;
}

function axisCells(axis: AxisDef | undefined): { address: string | null; count: number | null } {
  if (axis !== undefined && axis.kind === 'referenced' && axis.address !== undefined) {
    return { address: hex(axis.address), count: axis.count };
  }
  return { address: null, count: null };
}

export function toMapListRecord(map: MapDef): MapListRecord {
  const x = axisCells(map.xAxis);
  const y = axisCells(map.yAxis);
  return {
    name: map.name,
    category: map.category ?? null,
    address: hex(map.address),
    rows: map.rows,
    cols: map.cols,
    width: map.format.width,
    signed: map.format.signed,
    endian: map.format.endianness,
    factor: map.scaling.factor,
    offset: map.scaling.offset,
    units: map.scaling.units,
    digits: map.scaling.digits,
    xAxisAddress: x.address,
    xAxisCount: x.count,
    yAxisAddress: y.address,
    yAxisCount: y.count,
    confidence: map.confidence ?? null,
    provenance: map.provenance,
    detector: map.detector ?? null,
    kind: isSwitch(map) ? 'switch' : isParamShaped(map) ? 'param' : null,
  };
}

function csvCell(v: string | number | boolean | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportMapListCsv(maps: MapDef[]): Result<string> {
  const rows = maps.map((m) => {
    const r = toMapListRecord(m);
    return [
      r.name, r.category, r.address, r.rows, r.cols, r.width, r.signed, r.endian, r.factor, r.offset,
      r.units, r.digits, r.xAxisAddress, r.xAxisCount, r.yAxisAddress, r.yAxisCount, r.confidence, r.provenance,
      r.detector, r.kind,
    ].map(csvCell).join(',');
  });
  return { ok: true, value: [CSV_HEADER, ...rows].join('\n') + '\n' };
}

export function exportMapListJson(maps: MapDef[]): Result<string> {
  return { ok: true, value: JSON.stringify(maps.map(toMapListRecord), null, 2) + '\n' };
}
