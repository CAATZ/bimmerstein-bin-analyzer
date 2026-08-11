import type { AxisDef, MapDef, ValueFormat } from './types.js';

/**
 * Value codecs — the ONLY place in the codebase that decodes cell bytes.
 * Implemented in plan Phase 1 (TDD). Contracts:
 *
 * - readValue: decode one cell at `offset`; returns raw (unscaled) number.
 *   Out-of-range offset for the format width is a programming error → throw RangeError.
 * - readGrid: bulk read honoring orientation; no allocation per cell beyond
 *   the result array (hexdump rendering calls this per frame).
 * - readAxisValues (added in task 1.3): decode an AxisDef (referenced/literal/index).
 * (Rendering-oriented helpers like readRow arrive with Plan C if needed.)
 */
export function readValue(bytes: Uint8Array, offset: number, format: ValueFormat): number {
  const { width } = format;
  if (offset < 0 || offset + width > bytes.length) {
    throw new RangeError(`readValue out of range: offset ${offset}, width ${width}, size ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = format.endianness === 'little';
  if (format.float) {
    if (width !== 4) throw new RangeError('float requires width 4');
    return view.getFloat32(offset, little);
  }
  switch (width) {
    case 1:
      return format.signed ? view.getInt8(offset) : view.getUint8(offset);
    case 2:
      return format.signed ? view.getInt16(offset, little) : view.getUint16(offset, little);
    case 4:
      return format.signed ? view.getInt32(offset, little) : view.getUint32(offset, little);
  }
}

export function readGrid(bytes: Uint8Array, map: MapDef): number[][] {
  const { rows, cols, format } = map;
  const w = format.width;
  const grid: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const cellIndex = map.orientation === 'row-major' ? r * cols + c : c * rows + r;
      row.push(readValue(bytes, map.address + cellIndex * w, format));
    }
    grid.push(row);
  }
  return grid;
}

export function readAxisValues(bytes: Uint8Array, axis: AxisDef): number[] {
  if (axis.kind === 'index') return Array.from({ length: axis.count }, (_, i) => i);
  if (axis.kind === 'literal') {
    if (!axis.values || axis.values.length !== axis.count) {
      throw new RangeError('literal axis requires values with length === count');
    }
    return [...axis.values];
  }
  if (axis.address === undefined || !axis.format) {
    throw new RangeError('referenced axis requires address and format');
  }
  const { address, format } = axis;
  return Array.from({ length: axis.count }, (_, i) => readValue(bytes, address + i * format.width, format));
}

/**
 * Mirror of readValue: lay a raw integer (or float) down at `offset`.
 * Same range contract — an offset that would run past the buffer is a
 * programming error, not something to silently truncate.
 */
export function writeValue(
  bytes: Uint8Array,
  offset: number,
  format: ValueFormat,
  raw: number
): void {
  const { width } = format;
  if (offset < 0 || offset + width > bytes.length) {
    throw new RangeError(`writeValue out of range: offset ${offset}, width ${width}, size ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = format.endianness === 'little';
  if (format.float === true) {
    if (width !== 4) throw new RangeError('float requires width 4');
    view.setFloat32(offset, raw, little);
    return;
  }
  switch (width) {
    case 1:
      if (format.signed) view.setInt8(offset, raw);
      else view.setUint8(offset, raw);
      return;
    case 2:
      if (format.signed) view.setInt16(offset, raw, little);
      else view.setUint16(offset, raw, little);
      return;
    case 4:
      if (format.signed) view.setInt32(offset, raw, little);
      else view.setUint32(offset, raw, little);
      return;
  }
}
