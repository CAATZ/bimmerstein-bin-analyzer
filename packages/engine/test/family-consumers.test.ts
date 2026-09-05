import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_CONFIG as cfg } from '../src/config.js';
import { analyzeMs41Consumers, instructionSuccessors, supportsSignedStorage } from '../src/family/ms41/consumers.js';
import { detectMs41Params } from '../src/family/ms41/params.js';

const image = () => new Uint8Array(0x40000);
const analyze = (bytes: Uint8Array) => analyzeMs41Consumers(bytes, [], new Map(), cfg);
const load = [0xf2, 0xf4, 0x20, 0x03]; // MOV r4,cal[0x320]

describe('MS41 raw-value consumer evidence', () => {
  it('distinguishes signed and unsigned comparisons of the loaded word', () => {
    const b = image();
    b.set([...load, 0x46, 0xf4, 0x00, 0x00, 0xcd, 0x00, 0xdb, 0x00], 0x100);
    expect(analyze(b).memory.get('800:2')).toMatchObject({ used: true, signed: true, unsigned: false });
    b[0x108] = 0x8d;
    expect(analyze(b).memory.get('800:2')).toMatchObject({ signed: false, unsigned: true });
  });

  it('does not transfer comparison evidence through a register overwrite or a biased byte', () => {
    const b = image();
    b.set([...load, 0xe6, 0xf4, 0x00, 0x00, 0x46, 0xf4, 0, 0, 0xcd, 0, 0xdb, 0], 0x100);
    b.set([0xf3, 0xf8, 0x40, 0x03, 0x27, 0xf8, 0x80, 0, 0xd0, 0x84, 0xdb, 0], 0x200);
    expect(analyze(b).memory.get('800:2')).toMatchObject({ signed: false });
    expect(analyze(b).memory.get('832:1')).toMatchObject({ used: true, signed: false });
  });

  it('follows a live value across a branch beyond the short switch-state window', () => {
    const b = image();
    b.set([0xc2, 0xf7, 0x20, 0x03, 0x9a, 0x00, 0x1c, 0x00], 0x100);
    b.set([0xe6, 0xf7, 0, 0, 0xdb, 0], 0x108);
    for (let p = 0x140; p < 0x160; p += 2) b.set([0xcc, 0], p);
    b.set([0xf0, 0xe7, 0xdb, 0], 0x160);
    expect(analyze(b).memory.get('800:1')).toMatchObject({ used: true, signed: false });
  });

  it('follows a raw call argument into a signed clamp helper', () => {
    const b = image();
    b.set([0xf2, 0xfd, 0x20, 0x03, 0xda, 0, 0, 0x60, 0xdb, 0], 0x100);
    b.set([0x48, 0xd0, 0xcd, 0, 0xdb, 0], 0x2000); // CPU 0x6000
    expect(analyze(b).memory.get('800:2')).toMatchObject({ used: true, signed: true });
  });

  it('follows a raw RAM publication to a later signed consumer', () => {
    const b = image();
    b.set([...load, 0xf6, 0xf4, 0x00, 0xe9, 0xdb, 0], 0x100);
    b.set([0xf2, 0xf5, 0x00, 0xe9, 0x46, 0xf5, 0, 0, 0xcd, 0, 0xdb, 0], 0x200);
    expect(analyze(b).memory.get('800:2')).toMatchObject({ signed: true });
  });

  it('classifies a table result from its caller instead of its reader name or address', () => {
    const b = image();
    b.set([0xda, 0, 0, 0x60, 0xd0, 0x84, 0xdb, 0], 0x100);
    const result = analyzeMs41Consumers(b, [{ siteFile: 0x100, targetCpu: 0x6000, sa: 0x500, dist: 0 }], new Map([[0x6000, 1]]), cfg);
    expect(result.tables.get(0x500)).toMatchObject({ signed: true, unsigned: false });
  });

  it('retains conflicting consumers and terminates a cyclic control-flow path', () => {
    const b = image();
    b.set([...load, 0x48, 0x40, 0xcd, 0, 0xdb, 0], 0x100);
    b.set([...load, 0x48, 0x40, 0x8d, 0, 0xdb, 0], 0x200);
    b.set([0xf2, 0xf4, 0x40, 0x03, 0x0d, 0xff], 0x300);
    const result = analyze(b);
    expect(result.memory.get('800:2')).toMatchObject({ signed: true, unsigned: true });
    expect(result.memory.get('832:2')).toMatchObject({ signed: false, used: false });
  });

  it('feeds signedness and long-lived membership into the shared parameter detector', () => {
    const b = image();
    b[0x14321] = 0x80;
    b.set([0xf2, 0xfd, 0x20, 0x03, 0xda, 0, 0, 0x60, 0xdb, 0], 0x100);
    b.set([0x48, 0xd0, 0xcd, 0, 0xdb, 0], 0x2000);
    b[0x14321] = 0x80;
    const evidence = analyze(b);
    const signed = detectMs41Params(b, cfg, evidence.memory).find(p => p.address === 0x14320);
    expect(signed?.format.signed).toBe(true);
    expect(signed?.states).toBeUndefined();
  });

  it('uses CPU-relative targets across swapped file banks', () => {
    const b = image();
    b.set([0x0d, 0], 0x7ffe); // CPU 0x3ffe -> CPU 0x4000 -> file 0
    expect(instructionSuccessors(b, 0x7ffe)).toEqual([0]);
    b.set([0x0d, 0], 0x3bffe); // CPU 0x3fffe wraps within CSP 3
    expect(instructionSuccessors(b, 0x3bffe)).toEqual([0x34000]);
  });

  it('does not carry a comparison through a flag-changing bit branch', () => {
    const b = image();
    b.set([...load, 0x48, 0x40, 0xaa, 0x15, 0, 0, 0xcd, 0, 0xdb, 0], 0x100);
    expect(analyze(b).memory.get('800:2')?.signed).toBe(false);
  });

  it('keeps nonnegative comparison limits unsigned when their storage sign is ambiguous', () => {
    const b = image();
    b.set([0xf3, 0xf8, 0x20, 0x03, 0x49, 0x80, 0xcd, 0, 0xdb, 0], 0x100);
    b[0x14320] = 0x7f;
    expect(detectMs41Params(b, cfg, analyze(b).memory).find(p => p.address === 0x14320)?.format.signed).toBe(false);
  });

  it('continues past an unrelated shift but does not preserve a shifted raw value', () => {
    const b = image();
    b.set([0xf2, 0xf7, 0x20, 0x03, 0x5c, 0x14, 0xf0, 0xe7, 0xdb, 0], 0x100);
    expect(analyze(b).memory.get('800:2')?.used).toBe(true);
    b.set([0xf2, 0xf7, 0x20, 0x03, 0x5c, 0x17, 0x48, 0x70, 0xcd, 0, 0xdb, 0], 0x100);
    expect(analyze(b).memory.get('800:2')?.signed).toBe(false);
  });

  it('follows a saved register across a helper only through its actual instructions', () => {
    const b = image();
    b.set([0xf2, 0xf8, 0x20, 0x03, 0xda, 0, 0, 0x60, 0x48, 0x80, 0xcd, 0, 0xdb, 0], 0x100);
    b.set([0x88, 0x40, 0xe0, 0x04, 0x98, 0x40, 0xdb, 0], 0x2000);
    expect(analyze(b).memory.get('800:2')?.signed).toBe(true);
    b.set([0xe0, 0x08, 0xdb, 0], 0x2000);
    expect(analyze(b).memory.get('800:2')?.signed).toBe(false);
    b.set([0x0c, 0, 0xdb, 0], 0x2000); // unknown effects
    expect(analyze(b).memory.get('800:2')?.signed).toBe(false);
  });

  it('does not confuse a short SFR operand with a general-purpose register', () => {
    const b = image();
    b.set([...load, 0x46, 0x04, 0, 0, 0xcd, 0, 0xdb, 0], 0x100);
    expect(analyze(b).memory.get('800:2')?.signed).toBe(false);
  });

  it('preserves an all-positive table representation even when its consumer sign-extends bytes', () => {
    const b = image();
    b.set([0xda, 0, 0, 0x60, 0xd0, 0x84, 0xdb, 0], 0x100);
    b.set([0, 0, 1, 2], 0x14500);
    const evidence = analyzeMs41Consumers(b, [{siteFile: 0x100, targetCpu: 0x6000, sa: 0x500, dist: 0}], new Map([[0x6000, 1]]), cfg).tables.get(0x500);
    const format = {width: 1, signed: false, endianness: 'little'} as const;
    expect(evidence?.signed).toBe(true);
    expect(supportsSignedStorage(b, 0x14500, 4, format, evidence)).toBe(false);
    b[0x14500] = 0xff;
    expect(supportsSignedStorage(b, 0x14500, 4, format, evidence)).toBe(true);
  });

  it('counts helper and RAM links against the same depth bound', () => {
    const b = image();
    b.set([0xf2, 0xfc, 0x20, 0x03, 0xda, 0, 0, 0x60, 0xdb, 0], 0x100);
    b.set([0xf6, 0xfc, 0, 0xe9, 0xdb, 0], 0x2000);
    b.set([0xf2, 0xf5, 0, 0xe9, 0x48, 0x50, 0xcd, 0, 0xdb, 0], 0x300);
    const shallow = {...cfg, family:{...cfg.family, ms41:{...cfg.family.ms41, consumerMaxDepth:1}}};
    expect(analyzeMs41Consumers(b, [], new Map(), shallow).memory.get('800:2')?.signed).toBe(false);
    expect(analyze(b).memory.get('800:2')?.signed).toBe(true);
  });

  it('does not transfer signed evidence between conflicting table-reader widths', () => {
    const b = image();
    b.set([0xda, 0, 0, 0x60, 0xd0, 0x84, 0xdb, 0], 0x100);
    b.set([0xda, 0, 0, 0x61, 0xdb, 0], 0x200);
    const calls = [{siteFile:0x100,targetCpu:0x6000,sa:0x500,dist:0},{siteFile:0x200,targetCpu:0x6100,sa:0x500,dist:0}];
    expect(analyzeMs41Consumers(b,calls,new Map([[0x6000,1],[0x6100,2]]),cfg).tables.has(0x500)).toBe(false);
  });

  it('does not trace RAM-resident code through the flash address transform', () => {
    const b = image();
    b.set([0xf2, 0xfc, 0x20, 0x03, 0xda, 0, 0, 0xc0, 0xdb, 0], 0x100);
    b.set([0x48, 0xc0, 0xcd, 0, 0xdb, 0], 0x8000);
    expect(analyze(b).memory.get('800:2')?.signed).toBe(false);
  });
});
