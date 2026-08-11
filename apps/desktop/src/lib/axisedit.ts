import type { AxisDef, MapDef } from '@binanalyzer/core';

/**
 * Only `referenced` axes are byte-editable: their values live in the bin.
 * `literal` axes carry their values in the definition itself, so changing one
 * is a definition edit (a project-file concern), and `index` axes are 0,1,2…
 * with no data anywhere. A referenced axis with no `format` is not editable
 * either — without a width and endianness we cannot lay a value down.
 */
export function axisEditability(axis: AxisDef | undefined): { editable: boolean; reason?: string } {
  if (axis === undefined) return { editable: false, reason: 'This map has no axis on that side.' };
  if (axis.kind === 'index') return { editable: false, reason: 'An index axis is 0,1,2… — there is nothing stored to edit.' };
  if (axis.kind === 'literal') return { editable: false, reason: 'A literal axis is stored in the definition, not the bin. Edit it in map properties.' };
  if (axis.address === undefined) return { editable: false, reason: 'This axis has no address.' };
  if (axis.format === undefined) return { editable: false, reason: 'This axis has no format, so its value width and endianness are unknown.' };
  return { editable: true };
}

/** Byte offset of axis value `index`, or null when the axis is not byte-backed. */
export function axisByteOffset(axis: AxisDef | undefined, index: number): number | null {
  if (axis === undefined || axis.kind !== 'referenced') return null;
  if (axis.address === undefined || axis.format === undefined) return null;
  return axis.address + index * axis.format.width;
}

const span = (a: AxisDef): { start: number; end: number } | null => {
  if (a.kind !== 'referenced' || a.address === undefined || a.format === undefined) return null;
  return { start: a.address, end: a.address + a.count * a.format.width };
};

/**
 * Names of the OTHER maps whose axis storage overlaps this axis.
 *
 * The fan-out is real: one breakpoint table in the ROM serves every map that
 * points at it, so editing it changes them all. This makes the blast radius
 * visible BEFORE the edit; the offset-keyed diff makes it visible after.
 */
export function mapsSharingAxis(
  maps: readonly MapDef[],
  axis: AxisDef,
  selfId: string
): string[] {
  const mine = span(axis);
  if (mine === null) return [];
  const out: string[] = [];
  for (const m of maps) {
    if (m.id === selfId) continue;
    for (const other of [m.xAxis, m.yAxis]) {
      if (other === undefined) continue;
      const s = span(other);
      if (s !== null && s.start < mine.end && mine.start < s.end) {
        out.push(m.name);
        break;
      }
    }
  }
  return out;
}

/**
 * Breakpoint axes are ordinarily ordered. A broken order is reported as a fact,
 * not blocked — some axes legitimately are not monotonic, and the ECU will
 * interpolate across whatever is there.
 */
export function isMonotonic(values: readonly number[]): boolean {
  let up = true;
  let down = true;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! < values[i - 1]!) up = false;
    if (values[i]! > values[i - 1]!) down = false;
  }
  return up || down;
}
