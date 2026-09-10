import type { FamilyAnalyzer } from '../../packages/engine/src/family/types.js';

// Synthetic BFAM v1 only; intentionally absent from the production registry.
const size = 128;
const headerEnd = 16;
const checksumStart = size - 2;
const word = { width: 2, signed: false, endianness: 'little' } as const;

export const demoAnalyzer: FamilyAnalyzer = {
  id: 'demo-bfam',
  analyze(bytes, _prefixedAxes, config) {
    if (bytes.length !== size || bytes[4] !== 1 ||
      bytes[0] !== 0x42 || bytes[1] !== 0x46 || bytes[2] !== 0x41 || bytes[3] !== 0x4d) return [];
    const rows = bytes[6]!;
    const cols = bytes[7]!;
    if (rows < config.table.minRows || rows > config.table.maxRows ||
      cols < config.table.minCols || cols > config.table.maxCols) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const xAddress = view.getUint16(8, true);
    const yAddress = view.getUint16(10, true);
    const address = view.getUint16(12, true);
    const spans = [
      { start: xAddress, end: xAddress + cols * word.width },
      { start: yAddress, end: yAddress + rows * word.width },
      { start: address, end: address + rows * cols * word.width },
    ].sort((a, b) => a.start - b.start);
    if (spans.some((span, i) => span.start < headerEnd || span.start % word.width !== 0 ||
      span.end > checksumStart || (i > 0 && spans[i - 1]!.end > span.start))) return [];
    return [{ address, rows, cols, format: word, tier: 0,
      score: config.pool.structConfidence,
      xAxis: { address: xAddress, count: cols, format: word },
      yAxis: { address: yAddress, count: rows, format: word } }];
  },
};
