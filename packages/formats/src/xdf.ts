import type { AxisDef, MapDef, Result, Scaling, ValueFormat } from '@binanalyzer/core';
import { isCurveShaped, toCanonicalCurve } from './curve.js';
import { renderAffineExpression } from './expression.js';
import { xmlEscape } from './xml.js';

/**
 * TunerPro XDF 1.70 export. XDF import is not supported.
 * Every emitted construct is copied from a TunerPro-WRITTEN golden sample
 * (test/fixtures/tunerpro-golden.xdf — the golden-sample rule forbids
 * trusting memory here): mmedtypeflags 0x01 = signed, 0x02 = LSB-first
 * (omitted when 0); CATEGORYMEM.category = CATEGORY.index + 1; referenced
 * axes become standalone 1×N axis-table objects linked with
 * <embedinfo type="3" linkobjid>; shared axes (the MS41 norm) dedupe to one
 * axis table. Non-affine scalings emit equation "X" (raw display — spec §3
 * forbids silent mis-scaling). Deterministic: uniqueids derive from position
 * (tables 0x1000+i, axis tables 0x8000+j); no timestamps.
 */

function hex(n: number): string {
  return `0x${n.toString(16).toUpperCase()}`;
}

function typeFlags(format: ValueFormat): string | undefined {
  let flags = 0;
  if (format.signed) flags |= 0x01;
  if (format.width > 1 && format.endianness === 'little') flags |= 0x02;
  return flags === 0 ? undefined : `0x${flags.toString(16).toUpperCase().padStart(2, '0')}`;
}

function equationOf(scaling: Scaling | undefined): string {
  if (scaling === undefined || scaling.rawExpression !== undefined) return 'X';
  return renderAffineExpression(scaling.factor, scaling.offset, 'X');
}

const DUMMY_EMBEDDED = '<EMBEDDEDDATA mmedelementsizebits="8" mmedmajorstridebits="-32" mmedminorstridebits="0" />';

function pushMath(out: string[], indent: string, scaling: Scaling | undefined): void {
  out.push(`${indent}<MATH equation="${xmlEscape(equationOf(scaling))}">`, `${indent}  <VAR id="X" />`, `${indent}</MATH>`);
}

interface SharedAxis {
  uid: number;
  axis: AxisDef;
  title: string;
}

function axisKey(axis: AxisDef): string | undefined {
  if (axis.kind !== 'referenced' || axis.address === undefined || axis.format === undefined) return undefined;
  const s = axis.scaling;
  // Scaling is part of the identity: two axes at the same address/format but
  // different physical scaling are NOT the same axis — deduping them would
  // silently apply one axis's scaling to the other (spec §3).
  const scalingKey = JSON.stringify([s?.factor, s?.offset, s?.units, s?.digits, s?.rawExpression]);
  return `${axis.address}:${axis.count}:${axis.format.width}:${axis.format.signed}:${axis.format.endianness}:${scalingKey}`;
}

/**
 * x/y axis of a map table: linked (referenced), LABEL list (literal), or index
 * LABELs. `dummy` is the curve-only degenerate slot (golden xdf:35-46): a 1D
 * table's unused Y carries the table's z units and the count-1 "0.00" label —
 * the same convention as the axis-table's dummy X below. Omitted everywhere
 * else, keeping 2D output byte-identical.
 */
function pushMapAxis(out: string[], id: 'x' | 'y', axis: AxisDef | undefined, count: number, shared: Map<string, SharedAxis>, dummy?: { units: string }): void {
  out.push(`    <XDFAXIS id="${id}" uniqueid="0x0">`, `      ${DUMMY_EMBEDDED}`);
  out.push(`      <units>${xmlEscape(dummy?.units ?? axis?.scaling?.units ?? '')}</units>`);
  out.push(`      <indexcount>${count}</indexcount>`);
  const key = axis === undefined ? undefined : axisKey(axis);
  if (key !== undefined) out.push(`      <embedinfo type="3" linkobjid="${hex(shared.get(key)!.uid)}" />`);
  out.push('      <datatype>0</datatype>', '      <unittype>0</unittype>', '      <DALINK index="0" />');
  if (key === undefined) {
    const labels = dummy !== undefined
      ? ['0.00']
      : axis?.kind === 'literal' && axis.values !== undefined
        ? axis.values.map((v) => String(v))
        : Array.from({ length: count }, (_, i) => String(i));
    labels.forEach((v, i) => out.push(`      <LABEL index="${i}" value="${xmlEscape(v)}" />`));
  }
  // Parent x/y MATH is always plain "X" in the golden corpus: for linked axes
  // the real equation lives on the axis-table z; literal LABEL values are
  // already physical.
  pushMath(out, '      ', undefined);
  out.push('    </XDFAXIS>');
}

export function exportXdf(title: string, binSize: number, maps: MapDef[]): Result<string> {
  for (const m of maps) {
    if (m.orientation !== 'row-major') return { ok: false, error: `map "${m.name}": col-major export is not supported` };
    if (m.format.float === true) return { ok: false, error: `map "${m.name}": float export is not supported` };
    for (const [role, axis, count] of [['x', m.xAxis, m.cols], ['y', m.yAxis, m.rows]] as const) {
      if (axis?.kind === 'literal' && (axis.values === undefined || axis.values.length !== count)) {
        return { ok: false, error: `map "${m.name}": literal ${role} axis has ${axis.values?.length ?? 0} values, expected ${count}` };
      }
    }
  }
  const categories: string[] = [];
  for (const m of maps) {
    if (m.category !== undefined && !categories.includes(m.category)) categories.push(m.category);
  }
  const shared = new Map<string, SharedAxis>();
  for (const m of maps) {
    for (const axis of [m.xAxis, m.yAxis]) {
      if (axis === undefined) continue;
      const key = axisKey(axis);
      if (key === undefined || shared.has(key)) continue;
      shared.set(key, {
        uid: 0x8000 + shared.size,
        axis,
        title: `Axis - ${axis.name ?? 'unnamed'} 1x${axis.count} ${hex(axis.address!)}`,
      });
    }
  }
  if (shared.size > 0 && !categories.includes('Axis')) categories.push('Axis');
  const categoryMem = (name: string | undefined, indent: string, out: string[]): void => {
    if (name === undefined) return;
    out.push(`${indent}<CATEGORYMEM index="0" category="${categories.indexOf(name) + 1}" />`);
  };

  const out: string[] = ['<XDFFORMAT version="1.70">', '  <XDFHEADER>', '    <flags>0x1</flags>'];
  out.push(`    <deftitle>${xmlEscape(title)}</deftitle>`);
  out.push('    <BASEOFFSET offset="0" subtract="0" />');
  out.push('    <DEFAULTS datasizeinbits="8" sigdigits="2" outputtype="1" signed="0" lsbfirst="0" float="0" />');
  out.push(`    <REGION type="0xFFFFFFFF" startaddress="0x0" size="${hex(binSize)}" regioncolor="0x0" regionflags="0x0" name="Binary File" desc="This region describes the bin file edited by this XDF" />`);
  categories.forEach((name, i) => out.push(`    <CATEGORY index="${hex(i)}" name="${xmlEscape(name)}" />`));
  out.push('  </XDFHEADER>');

  maps.forEach((mRaw, i) => {
    // TunerPro 1D convention (golden xdf:19-58): a curve's REAL axis lives in
    // the X slot with mmedrowcount=1 — the transpose of our canonical N×1.
    // Canonicalize first so both def orientations export identically.
    const curve = isCurveShaped(mRaw);
    const m = curve ? toCanonicalCurve(mRaw) : mRaw;
    out.push(`  <XDFTABLE uniqueid="${hex(0x1000 + i)}" flags="0x30">`);
    out.push(`    <title>${xmlEscape(m.name)}</title>`);
    if (m.notes !== undefined) out.push(`    <description>${xmlEscape(m.notes)}</description>`);
    categoryMem(m.category, '    ', out);
    if (curve) {
      pushMapAxis(out, 'x', m.yAxis, m.rows, shared);
      pushMapAxis(out, 'y', undefined, 1, shared, { units: m.scaling.units });
    } else {
      pushMapAxis(out, 'x', m.xAxis, m.cols, shared);
      pushMapAxis(out, 'y', m.yAxis, m.rows, shared);
    }
    out.push('    <XDFAXIS id="z">');
    const flags = typeFlags(m.format);
    const flagsAttr = flags === undefined ? '' : `mmedtypeflags="${flags}" `;
    const [zRows, zCols] = curve ? [1, m.rows] : [m.rows, m.cols];
    out.push(
      `      <EMBEDDEDDATA ${flagsAttr}mmedaddress="${hex(m.address)}" mmedelementsizebits="${m.format.width * 8}" mmedrowcount="${zRows}" mmedcolcount="${zCols}" mmedmajorstridebits="0" mmedminorstridebits="0" />`
    );
    out.push(`      <units>${xmlEscape(m.scaling.units)}</units>`);
    out.push(`      <decimalpl>${m.scaling.digits}</decimalpl>`);
    out.push('      <outputtype>1</outputtype>');
    pushMath(out, '      ', m.scaling);
    out.push('    </XDFAXIS>', '  </XDFTABLE>');
  });

  for (const { uid, axis, title: axisTitle } of shared.values()) {
    const format = axis.format!;
    out.push(`  <XDFTABLE uniqueid="${hex(uid)}" flags="0x30">`);
    out.push(`    <title>${xmlEscape(axisTitle)}</title>`);
    categoryMem('Axis', '    ', out);
    out.push('    <XDFAXIS id="x" uniqueid="0x0">', `      ${DUMMY_EMBEDDED}`);
    out.push('      <indexcount>1</indexcount>', '      <datatype>0</datatype>', '      <unittype>0</unittype>', '      <DALINK index="0" />');
    out.push('      <LABEL index="0" value="0.00" />');
    pushMath(out, '      ', undefined);
    out.push('    </XDFAXIS>');
    out.push('    <XDFAXIS id="y" uniqueid="0x0">', `      ${DUMMY_EMBEDDED}`);
    out.push(`      <indexcount>${axis.count}</indexcount>`, '      <outputtype>2</outputtype>', '      <datatype>0</datatype>', '      <unittype>0</unittype>', '      <DALINK index="0" />');
    for (let i = 0; i < axis.count; i++) out.push(`      <LABEL index="${i}" value="${String(i + 1).padStart(2, '0')}" />`);
    pushMath(out, '      ', undefined);
    out.push('    </XDFAXIS>');
    out.push('    <XDFAXIS id="z">');
    const flags = typeFlags(format);
    const flagsAttr = flags === undefined ? '' : `mmedtypeflags="${flags}" `;
    out.push(
      `      <EMBEDDEDDATA ${flagsAttr}mmedaddress="${hex(axis.address!)}" mmedelementsizebits="${format.width * 8}" mmedrowcount="${axis.count}" mmedmajorstridebits="0" mmedminorstridebits="0" />`
    );
    out.push(`      <units>${xmlEscape(axis.scaling?.units ?? '')}</units>`);
    out.push(`      <decimalpl>${axis.scaling?.digits ?? 0}</decimalpl>`);
    out.push('      <outputtype>1</outputtype>');
    pushMath(out, '      ', axis.scaling);
    out.push('    </XDFAXIS>', '  </XDFTABLE>');
  }

  out.push('</XDFFORMAT>');
  return { ok: true, value: out.join('\n') + '\n' };
}
