import { describe, expect, it } from 'vitest';
import { C166_OPCODE_LEN, classifyReaderWidth, scanReaderCalls } from '../src/family/ms41/c166.js';

/** Assemble a code snippet at offset 0 of a small single-chunk buffer. */
function code(bytes: number[], size = 0x100): Uint8Array {
  const buf = new Uint8Array(size);
  buf.set(bytes, 0);
  return buf;
}

describe('C166_OPCODE_LEN', () => {
  it('matches known encodings', () => {
    expect(C166_OPCODE_LEN[0xe6]).toBe(4); // MOV Rwn,#data16
    expect(C166_OPCODE_LEN[0xda]).toBe(4); // CALLS seg,#off16
    expect(C166_OPCODE_LEN[0xfa]).toBe(4); // JMPS seg,#off16
    expect(C166_OPCODE_LEN[0x06]).toBe(4); // ADD Rwn,#data16 (reg,#imm16 ALU form)
    expect(C166_OPCODE_LEN[0xa9]).toBe(2); // MOVB Rbn,[Rwm]
    expect(C166_OPCODE_LEN[0x99]).toBe(2); // MOVB Rbn,[Rwm+]
    expect(C166_OPCODE_LEN[0xa8]).toBe(2); // MOV Rwn,[Rwm]
    expect(C166_OPCODE_LEN[0x98]).toBe(2); // MOV Rwn,[Rwm+]
    expect(C166_OPCODE_LEN[0xd4]).toBe(4); // MOV Rwn,[Rwm+#d16]
    expect(C166_OPCODE_LEN[0xf0]).toBe(2); // MOV Rwn,Rwm
    expect(C166_OPCODE_LEN[0xdb]).toBe(2); // RETS
  });

  it('holds only 0/2/4 and covers the 198 observed opcodes plus JMPS', () => {
    expect(C166_OPCODE_LEN).toHaveLength(256);
    expect(C166_OPCODE_LEN.every((l) => l === 0 || l === 2 || l === 4)).toBe(true);
    expect(C166_OPCODE_LEN.filter((l) => l !== 0)).toHaveLength(199);
  });
});

describe('scanReaderCalls', () => {
  it('scans the executable half of a mixed calibration/code bank', () => {
    const bytes = new Uint8Array(0x18000);
    const call = [0xe6, 0xfc, 0x34, 0x12, 0xda, 0x03, 0xa6, 0x4b];
    bytes.set(call, 0x10000);
    bytes.set(call, 0x12000);
    bytes.set(call, 0x14000);
    expect(scanReaderCalls(bytes, 6)).toEqual([{ siteFile: 0x12004, targetCpu: 0x034ba6, sa: 0x1234, dist: 0 }]);
  });
  it.each([0x08, 0x18, 0x28, 0x38, 0x58, 0x68, 0x78])('rejects a stale pointer after short ALU opcode %i writes r12', (op) => {
    const bytes = code([0xe6, 0xfc, 0x34, 0x12, op, 0xc1, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toEqual([]);
  });

  it('keeps tracking through a comparison of r12 with a short immediate', () => {
    const bytes = code([0xe6, 0xfc, 0x34, 0x12, 0x48, 0xc1, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toEqual([{ siteFile: 6, targetCpu: 0x034ba6, sa: 0x1234, dist: 1 }]);
  });

  it('does not decode a far jump address as an instruction', () => {
    const bytes = code([0xfa, 0x00, 0xe6, 0xfc, 0xe6, 0xfc, 0x34, 0x12, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toEqual([{ siteFile: 8, targetCpu: 0x034ba6, sa: 0x1234, dist: 0 }]);
  });

  it('records a CALLS consuming a fresh MOV r12,#data16', () => {
    // MOV r12,#0x1234; 2-byte filler; CALLS seg 3, 0x4ba6
    const bytes = code([0xe6, 0xfc, 0x34, 0x12, 0x08, 0x11, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toEqual([
      { siteFile: 6, targetCpu: 0x034ba6, sa: 0x1234, dist: 1 },
    ]);
  });

  it('treats unobserved opcodes as 2-byte and keeps tracking', () => {
    // 0x0c is unobserved (len 0 → decode as 2)
    const bytes = code([0xe6, 0xfc, 0x34, 0x12, 0x0c, 0x11, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toHaveLength(1);
  });

  it('expires the freshness window past maxDist instructions', () => {
    const filler = Array.from({ length: 7 }, () => [0x08, 0x11]).flat(); // 7 instructions
    const bytes = code([0xe6, 0xfc, 0x34, 0x12, ...filler, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toEqual([]);
  });

  it('a second MOV r12 refreshes value and distance', () => {
    const bytes = code([0xe6, 0xfc, 0x34, 0x12, 0xe6, 0xfc, 0x78, 0x56, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toEqual([
      { siteFile: 8, targetCpu: 0x034ba6, sa: 0x5678, dist: 0 },
    ]);
  });

  it('CALLS consumes freshness — a second CALLS records nothing', () => {
    const bytes = code([0xe6, 0xfc, 0x34, 0x12, 0xda, 0x03, 0xa6, 0x4b, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toHaveLength(1);
  });

  it('reg,#imm16 ALU to r12 clobbers freshness', () => {
    // ADD r12,#1 between MOV and CALLS
    const bytes = code([0xe6, 0xfc, 0x34, 0x12, 0x06, 0xfc, 0x01, 0x00, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toEqual([]);
  });

  it('reg,reg move to r12 clobbers freshness', () => {
    // MOV r12,r3 (F0 C3) between MOV and CALLS
    const bytes = code([0xe6, 0xfc, 0x34, 0x12, 0xf0, 0xc3, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toEqual([]);
  });

  it('control-transfer opcodes end the window', () => {
    // RETS (DB) between MOV and CALLS
    const bytes = code([0xe6, 0xfc, 0x34, 0x12, 0xdb, 0x00, 0xda, 0x03, 0xa6, 0x4b]);
    expect(scanReaderCalls(bytes, 6)).toEqual([]);
  });

  it('freshness resets at every 0x4000 bank-half boundary', () => {
    const bytes = new Uint8Array(0x8000);
    bytes.set([0xe6, 0xfc, 0x34, 0x12], 0x3ffc); // MOV ends exactly at the boundary
    bytes.set([0xda, 0x03, 0xa6, 0x4b], 0x4000); // CALLS opens the next chunk
    expect(scanReaderCalls(bytes, 6)).toEqual([]);
  });

  it('skips the cal-window chunks entirely', () => {
    const bytes = new Uint8Array(0x18000);
    bytes.set([0xe6, 0xfc, 0x34, 0x12, 0xda, 0x03, 0xa6, 0x4b], 0x14000);
    expect(scanReaderCalls(bytes, 6)).toEqual([]);
  });
});

describe('classifyReaderWidth', () => {
  it.each([0x001000, 0x021000])('reads a flash callee at CPU %i through the address-line inversion', (cpu) => {
    const bytes = new Uint8Array(0x40000);
    bytes.set([0xdb, 0x00], cpu); // the unconverted offset is not this callee
    bytes.set([0xa8, 0x24], cpu ^ 0x4000);
    expect(classifyReaderWidth(bytes, cpu, 40)).toBe(2);
  });

  it('does not classify segment-0 RAM code using unrelated flash bytes', () => {
    const bytes = new Uint8Array(0x10000);
    bytes.set([0xa8, 0x24], 0x8000);
    expect(classifyReaderWidth(bytes, 0xc000, 40)).toBe(0);
  });

  /** Plant a CPU 0x1000 callee at its flash offset 0x5000. */
  function body(bytes: number[]): Uint8Array {
    const buf = new Uint8Array(0x6000);
    buf.set(bytes, 0x5000);
    return buf;
  }

  it('classifies a byte reader from MOVB fetch opcodes', () => {
    expect(classifyReaderWidth(body([0x08, 0x11, 0xa9, 0x24]), 0x1000, 40)).toBe(1);
    expect(classifyReaderWidth(body([0x99, 0x24]), 0x1000, 40)).toBe(1);
  });

  it('classifies a word reader from MOV fetch opcodes', () => {
    expect(classifyReaderWidth(body([0x08, 0x11, 0xa8, 0x24]), 0x1000, 40)).toBe(2);
    expect(classifyReaderWidth(body([0xd4, 0x42, 0x06, 0x00]), 0x1000, 40)).toBe(2);
  });

  it('returns 0 when the body returns before fetching', () => {
    expect(classifyReaderWidth(body([0x08, 0x11, 0xdb, 0x00]), 0x1000, 40)).toBe(0);
  });

  it('returns 0 when maxInstr is exhausted without a fetch', () => {
    const filler = Array.from({ length: 40 }, () => [0x08, 0x11]).flat();
    expect(classifyReaderWidth(body([...filler, 0xa9, 0x24]), 0x1000, 40)).toBe(0);
  });
});
