import { readValue, type ValueFormat } from '@binanalyzer/core';
import { MCP_CONFIG } from '../config.js';
import { asArgs, optEnum, optInt, reqAddress, reqString } from '../args.js';
import { err, ok, unknownBin, type ToolSpec } from '../result.js';

const DEFAULT_FORMAT: ValueFormat = { width: 1, signed: false, endianness: 'little' };

function parseFormat(v: unknown): { ok: true; value: ValueFormat } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: { ...DEFAULT_FORMAT } };
  if (typeof v !== 'object' || v === null) return { ok: false, error: '"format" must be an object' };
  const o = v as Record<string, unknown>;
  const width = o['width'] ?? 1;
  if (width !== 1 && width !== 2 && width !== 4) return { ok: false, error: '"format.width" must be 1, 2 or 4' };
  const signed = o['signed'] ?? false;
  if (typeof signed !== 'boolean') return { ok: false, error: '"format.signed" must be a boolean' };
  const endianness = o['endianness'] ?? 'big';
  if (endianness !== 'little' && endianness !== 'big') return { ok: false, error: '"format.endianness" must be "little" or "big"' };
  const float = o['float'];
  if (float !== undefined && typeof float !== 'boolean') return { ok: false, error: '"format.float" must be a boolean' };
  if (float === true && width !== 4) return { ok: false, error: '"format.float" requires width 4' };
  return { ok: true, value: { width, signed, endianness, ...(float === true ? { float: true } : {}) } };
}

const hex2 = (b: number): string => b.toString(16).padStart(2, '0');
const printable = (b: number): string => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.');

export const readBytesTool: ToolSpec = {
  name: 'read_bytes',
  description:
    'Read a bounded window of the bin as hex and/or decoded cell values. This is the "am I looking at a map?" loop: eyeball a region, spot a rectangular pattern, then confirm it with read_map using an ad-hoc definition. A read that runs past the end of the file is clamped, not an error.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['binId', 'address'],
    properties: {
      binId: { type: 'string', description: 'sha256 handle from open_bin.' },
      address: { type: ['integer', 'string'], description: 'File offset; integer or 0x-hex string.' },
      length: { type: 'integer', minimum: 1, maximum: MCP_CONFIG.readBytesMaxLength, default: MCP_CONFIG.readBytesDefaultLength, description: 'Bytes to read.' },
      as: { enum: ['hex', 'values', 'both'], default: 'hex' },
      format: {
        type: 'object',
        additionalProperties: false,
        description: 'Cell format for as:"values"|"both". Defaults to unsigned width 1.',
        properties: {
          width: { enum: [1, 2, 4], default: 1 },
          signed: { type: 'boolean', default: false },
          endianness: { enum: ['little', 'big'], default: 'big' },
          float: { type: 'boolean', description: 'width 4 IEEE754 only' },
        },
      },
      cols: { type: 'integer', minimum: 1, maximum: 64, default: MCP_CONFIG.readBytesDefaultCols, description: 'Cells per output row (bytes per row for hex).' },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const id = reqString(a, 'binId');
    if (!id.ok) return err(id.error);
    const address = reqAddress(a, 'address');
    if (!address.ok) return err(address.error);
    const length = optInt(a, 'length', MCP_CONFIG.readBytesDefaultLength, 1, MCP_CONFIG.readBytesMaxLength);
    if (!length.ok) return err(length.error);
    const as = optEnum(a, 'as', ['hex', 'values', 'both'] as const, 'hex');
    if (!as.ok) return err(as.error);
    const cols = optInt(a, 'cols', MCP_CONFIG.readBytesDefaultCols, 1, 64);
    if (!cols.ok) return err(cols.error);
    const format = parseFormat(a['format']);
    if (!format.ok) return err(format.error);

    const entry = deps.store.get(id.value);
    if (entry === undefined) return unknownBin(deps, id.value);
    if (address.value >= entry.size) {
      return err(`address 0x${address.value.toString(16)} is at or past the end of "${entry.name}" (${entry.size} bytes)`);
    }

    const end = Math.min(address.value + length.value, entry.size);
    const actual = end - address.value;
    const body: Record<string, unknown> = {
      binId: entry.binId,
      address: address.value,
      length: actual,
      as: as.value,
      cols: cols.value,
      clamped: actual < length.value,
    };

    if (as.value === 'hex' || as.value === 'both') {
      const rows: Array<{ address: number; bytes: string; ascii: string }> = [];
      for (let off = address.value; off < end; off += cols.value) {
        const stop = Math.min(off + cols.value, end);
        const slice = entry.bytes.subarray(off, stop);
        rows.push({
          address: off,
          bytes: Array.from(slice, hex2).join(' '),
          ascii: Array.from(slice, printable).join(''),
        });
      }
      body['hex'] = rows;
    }

    if (as.value === 'values' || as.value === 'both') {
      const w = format.value.width;
      const wholeCells = Math.floor(actual / w);
      const rows: number[][] = [];
      for (let i = 0; i < wholeCells; i += cols.value) {
        const row: number[] = [];
        for (let c = i; c < Math.min(i + cols.value, wholeCells); c++) row.push(readValue(entry.bytes, address.value + c * w, format.value));
        rows.push(row);
      }
      body['values'] = rows;
      body['format'] = format.value;
      // A trailing partial cell is dropped rather than decoded from
      // out-of-window bytes; say how many bytes went unused.
      body['bytesDropped'] = actual - wholeCells * w;
    }

    const region = entry.scan?.result.regions.find((r) => address.value >= r.start && address.value < r.end);
    if (region !== undefined) body['regionKind'] = region.kind;

    return ok(body);
  },
};
