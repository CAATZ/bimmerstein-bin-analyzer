import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectMs41Params, scanParamSites, PARAM_TIER } from '../src/family/ms41/params.js';
import { MS41_MIN_BIN_LEN, saToFo } from '../src/family/ms41/frame.js';
import { scan } from '../src/index.js';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';

const cfg = DEFAULT_SCAN_CONFIG;

/** Full-size zeroed image; code planted at CODE, stock bytes at saToFo(sa). */
function image(): Uint8Array {
  return new Uint8Array(MS41_MIN_BIN_LEN);
}
const CODE = 0x100;
/** Append raw instruction bytes; returns next offset. */
function emit(buf: Uint8Array, at: number, ...bs: number[]): number {
  buf.set(bs, at);
  return at + bs.length;
}
// Encodings (C166_OPCODE_LEN-consistent; reg 4 throughout, F-form b1 = 0xF4):
const loadB = (sa: number) => [0xf3, 0xf4, sa & 0xff, sa >> 8]; // MOVB rb4,mem (byteOp)
const loadW = (sa: number) => [0xf2, 0xf4, sa & 0xff, sa >> 8]; // MOV r4,mem (wordOp)
const loadBZ = (sa: number) => [0xc2, 0xf4, sa & 0xff, sa >> 8]; // MOVBZ r4,mem (byte DATA, word-space tests)
const cmpBImm = (imm: number) => [0x47, 0xf4, imm, 0x00]; // CMPB rb4,#imm8
const cmpBShort = (d3: number) => [0x49, 0x40 | d3]; // CMPB short — reg HIGH nibble, #data3 LOW
const andBShort7 = () => [0x69, 0x47]; // ANDB rb4,#7 short
const cmpWImm = (imm: number) => [0x46, 0xf4, imm & 0xff, imm >> 8]; // CMP r4,#imm16
const cmpBMem = (sa: number) => [0x43, 0xf4, sa & 0xff, sa >> 8]; // CMPB rb4,mem (self-test)
const calls = () => [0xda, 0x01, 0x00, 0x80]; // CALLS (also a window ender)
const jmpr = () => [0x0d, 0x00]; // JMPR (len 2, low nibble 0xD)
const nop = () => [0xcc, 0x00]; // filler, not an ender

describe('scanParamSites / detectMs41Params — S* census component tests', () => {
  it('a: plain byte load + reg-matching CMPB #imm → V1b param, u8', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x02dc));
    o = emit(buf, o, ...cmpBImm(0x7d));
    buf[saToFo(0x02dc)] = 0x7d;
    const out = detectMs41Params(buf, cfg);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      address: saToFo(0x02dc),
      rows: 1,
      cols: 1,
      format: { width: 1, signed: false },
      score: cfg.family.ms41.paramConfidence,
      tier: PARAM_TIER,
      kind: 'param',
    });
  });

  it('b: MOVBZ byte load matches WORD-space tests (measured-best semantics) and emits u8', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadBZ(0x0218));
    o = emit(buf, o, ...cmpWImm(0x0002));
    const out = detectMs41Params(buf, cfg);
    expect(out).toHaveLength(1);
    expect(out[0]!.format.width).toBe(1); // byte DATA class regardless of word-space matching
  });

  it('c: word load + CMP #imm16 → u16-LE param', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadW(0x033a));
    o = emit(buf, o, ...cmpWImm(0x1234));
    const out = detectMs41Params(buf, cfg);
    expect(out).toHaveLength(1);
    expect(out[0]!.format).toEqual({ width: 2, signed: false, endianness: 'little' });
  });

  it('d: self-testing CMPB reg,mem (V1a) qualifies', () => {
    const buf = image();
    emit(buf, CODE, ...cmpBMem(0x0216));
    expect(detectMs41Params(buf, cfg)).toHaveLength(1);
  });

  it('e: bare load with no test/JMPR/CALLS in the window does NOT qualify (V0-only excluded)', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x02bc));
    for (let i = 0; i < 10; i++) o = emit(buf, o, ...nop());
    expect(detectMs41Params(buf, cfg)).toHaveLength(0);
  });

  it('f: load + JMPR within 2 (flag idiom, V1c) qualifies', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x0270));
    o = emit(buf, o, ...jmpr());
    expect(detectMs41Params(buf, cfg)).toHaveLength(1);
  });

  it('g: load + CALLS at distance ≤ paramCallsMax qualifies; beyond it does not (the =2 pin)', () => {
    const near = image();
    let o = CODE;
    o = emit(near, o, ...loadB(0x0228));
    o = emit(near, o, ...nop());
    o = emit(near, o, ...calls()); // callsDist = 2
    expect(detectMs41Params(near, cfg)).toHaveLength(1);

    const far = image();
    o = CODE;
    o = emit(far, o, ...loadB(0x0228));
    o = emit(far, o, ...nop());
    o = emit(far, o, ...nop());
    o = emit(far, o, ...calls()); // callsDist = 3 > paramCallsMax 2
    expect(detectMs41Params(far, cfg)).toHaveLength(0);
  });

  it('h: mixed byte+word evidence on one SA emits u8 (smallest claim), one detection', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadW(0x039e));
    o = emit(buf, o, ...cmpWImm(0x0100));
    o = emit(buf, o, ...loadB(0x039e));
    o = emit(buf, o, ...cmpBImm(0x14));
    const out = detectMs41Params(buf, cfg);
    expect(out).toHaveLength(1);
    expect(out[0]!.format.width).toBe(1);
  });

  it('i: sites inside cal-window chunks are ignored (chunk skip)', () => {
    const buf = image();
    // 0x14000 is a cal-window chunk start — plant a "perfect" site there.
    let o = 0x14100;
    o = emit(buf, o, ...loadB(0x02dc));
    o = emit(buf, o, ...cmpBImm(0x7d));
    expect(detectMs41Params(buf, cfg)).toHaveLength(0);
  });

  it('j: u16 at the SA 0x3fff frame seam is skipped (saSpanContiguous)', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadW(0x3fff));
    o = emit(buf, o, ...cmpWImm(0x0001));
    expect(detectMs41Params(buf, cfg)).toHaveLength(0);
  });

  it('k: scanParamSites reports census fields (transcription contract)', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x0216));
    o = emit(buf, o, ...nop());
    o = emit(buf, o, ...cmpBImm(0x02));
    const sites = scanParamSites(buf, cfg.family.ms41.paramTestWindow);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ sa: 0x0216, reg: 4, byteOp: true, selfTest: false, regTestDist: 2 });
  });
});

describe('param tier — pinned ZERO through the real scan() on EVERY committed synthetic fixture', () => {
  // The spec's hard gate: synth-curve fixtures FULLY activate the family
  // analyzer and their zero rests on the generator's structurally-zero
  // direct-mem-read property (spike-measured, previously unpinned); the
  // others are inactive (no readers / below MS41_MIN_BIN_LEN). All pinned
  // identically: zero 1×1 emissions end-to-end.
  const FIXTURES = [
    'synth-1', 'synth-2', 'synth-pool-101', 'synth-pool-103',
    'synth-partial-201', 'synth-partial-203',
    'synth-curve-301', 'synth-curve-303', 'synth-curve-305', 'synth-curve-307',
    'synth-pcurve-401', 'synth-pcurve-403',
  ] as const;
  for (const name of FIXTURES) {
    it(`${name}: zero 1×1 emissions`, { timeout: 60_000 }, () => {
      const bytes = new Uint8Array(
        readFileSync(new URL(`../../../fixtures/synthetic/${name}.bin`, import.meta.url))
      );
      const maps = scan(bytes, cfg).potentialMaps;
      expect(maps.filter((m) => m.rows === 1 && m.cols === 1)).toHaveLength(0);
    });
  }

  it('synth-curve fixtures have a structurally-zero S* census (direct call, generator property)', () => {
    for (const name of ['synth-curve-301', 'synth-curve-303', 'synth-curve-305', 'synth-curve-307'] as const) {
      const bytes = new Uint8Array(
        readFileSync(new URL(`../../../fixtures/synthetic/${name}.bin`, import.meta.url))
      );
      expect(detectMs41Params(bytes, cfg)).toHaveLength(0);
    }
  });
});

describe('states synthesis — register-still-holds-load discipline', () => {
  const loadB2 = (sa: number) => [0xf3, 0xf5, sa & 0xff, sa >> 8]; // MOVB rb5,mem — a DIFFERENT register

  it('s1: load + CMPB #imm synthesizes stock-first states', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x0216));
    o = emit(buf, o, ...cmpBImm(0x02));
    o = emit(buf, o, ...cmpBShort(0x04));
    buf[saToFo(0x0216)] = 0x01;
    const out = detectMs41Params(buf, cfg);
    expect(out).toHaveLength(1);
    expect(out[0]!.states).toEqual([
      { name: '0x01 (stock)', data: [0x01] },
      { name: '0x02', data: [0x02] },
      { name: '0x04', data: [0x04] },
    ]);
  });

  it('s2: RELOAD kills collection — the 0x3a0 phantom emits stateless', () => {
    // Ladder-measured phantom: the window imms test a RELOADED register.
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x03a0)); // load rb4 ← 0x3a0
    o = emit(buf, o, ...loadB(0x0100)); // rb4 RELOADED from elsewhere
    o = emit(buf, o, ...cmpBImm(0x01)); // tests the reload, not 0x3a0
    o = emit(buf, o, ...cmpBImm(0x02));
    const out = detectMs41Params(buf, cfg);
    const p3a0 = out.find((d) => d.address === saToFo(0x03a0));
    expect(p3a0).toBeDefined();
    expect(p3a0!.states).toBeUndefined(); // param emitted, NO states
  });

  it('s3: immediate-mask ANDB preserves aliveness — the one-hot idiom recovers', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x33e0));
    o = emit(buf, o, ...andBShort7()); // ANDB rb4,#7 — mask, keeps alive
    o = emit(buf, o, ...cmpBShort(0x01));
    buf[saToFo(0x33e0)] = 0x02;
    const out = detectMs41Params(buf, cfg);
    expect(out[0]!.states).toEqual([
      { name: '0x02 (stock)', data: [0x02] },
      { name: '0x01', data: [0x01] },
    ]);
  });

  it('s4: mask/logic immediates are never state values; ORB kills', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x0270));
    o = emit(buf, o, 0x77, 0xf4, 0x10, 0x00); // ORB rb4,#0x10 — writes rb4, kills
    o = emit(buf, o, ...cmpBImm(0x30)); // post-kill: not collected
    const out = detectMs41Params(buf, cfg);
    expect(out).toHaveLength(1);
    expect(out[0]!.states).toBeUndefined();
  });

  it('s5: a test on a DIFFERENT register never contributes states', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x0218));
    o = emit(buf, o, ...loadB2(0x0219)); // rb5 load — does not touch rb4
    o = emit(buf, o, 0x47, 0xf5, 0x03, 0x00); // CMPB rb5,#3
    o = emit(buf, o, ...cmpBImm(0x01)); // rb4 test, still alive → collected
    const out = detectMs41Params(buf, cfg);
    const p218 = out.find((d) => d.address === saToFo(0x0218))!;
    expect(p218.states).toEqual([
      { name: '0x00 (stock)', data: [0x00] },
      { name: '0x01', data: [0x01] },
    ]);
  });

  it('s6: MOVBZ word-space equality ≤ 0xFF synthesizes; > 0xFF is dropped', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadBZ(0x0228));
    o = emit(buf, o, ...cmpWImm(0x0004));
    o = emit(buf, o, ...cmpWImm(0x1234)); // > 0xFF — not byte-representable
    const out = detectMs41Params(buf, cfg);
    expect(out[0]!.states).toEqual([
      { name: '0x00 (stock)', data: [0x00] },
      { name: '0x04', data: [0x04] },
    ]);
  });

  it('s7: u16 params never carry states (canonical switch shape is u8)', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadW(0x033a));
    o = emit(buf, o, ...cmpWImm(0x0004));
    const out = detectMs41Params(buf, cfg);
    expect(out[0]!.format.width).toBe(2);
    expect(out[0]!.states).toBeUndefined();
  });

  it('s9: ANDB reg,MEM kills (masking with a memory value is not an immediate mask)', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x0270));
    o = emit(buf, o, 0x63, 0xf4, 0x00, 0x01); // ANDB rb4,mem[0x0100] — combines with memory
    o = emit(buf, o, ...cmpBImm(0x05));
    const p = detectMs41Params(buf, cfg).find((d) => d.address === saToFo(0x0270))!;
    expect(p.states).toBeUndefined();
  });

  it('s9b: ADD Rbn,#data3 short form kills (structural write coverage, not a hand-listed opcode)', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x0272));
    o = emit(buf, o, 0x09, 0x41); // ADDB rb4,#1 — short form, dest HIGH nibble
    o = emit(buf, o, ...cmpBImm(0x06));
    const p = detectMs41Params(buf, cfg).find((d) => d.address === saToFo(0x0272))!;
    expect(p.states).toBeUndefined();
  });

  it('s10: a WORD write to the containing register kills a byte-space site (C166 register aliasing)', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x0228)); // rb4 — lives inside word reg r2
    o = emit(buf, o, 0xe6, 0xf2, 0x34, 0x12); // MOV r2,#0x1234 — clobbers rb4/rb5
    o = emit(buf, o, ...cmpBImm(0x01));
    const p = detectMs41Params(buf, cfg).find((d) => d.address === saToFo(0x0228))!;
    expect(p.states).toBeUndefined();
  });

  it('s11: word-site immediates never become states on a mixed-evidence u8 SA', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadW(0x0300)); // word site with a ≤0xFF equality test
    o = emit(buf, o, ...cmpWImm(0x0042));
    o = emit(buf, o, ...loadB(0x0300)); // byte site, no test of its own
    o = emit(buf, o, ...nop());
    const out = detectMs41Params(buf, cfg);
    const p = out.find((d) => d.address === saToFo(0x0300))!;
    expect(p.format.width).toBe(1); // byte-DATA evidence wins (smallest claim)
    expect(p.states).toBeUndefined(); // 0x42 tested a 16-bit value, not this byte
  });

  it('s8: stock byte equal to a tested immediate dedupes (stock listed once)', () => {
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x0216));
    o = emit(buf, o, ...cmpBImm(0x01));
    buf[saToFo(0x0216)] = 0x01;
    const out = detectMs41Params(buf, cfg);
    expect(out[0]!.states).toBeUndefined(); // sole imm == stock → no information beyond stock → stateless
  });

  it('s12: ANDB short-form INDIRECT ([Rwi]) kills — only #data3 (low nibble ≤7) preserves, not [Rwi] (≥8)', () => {
    // Op 0x69 (ANDB short form) is ambiguous by b1's low nibble: ≤7 is a
    // true #data3 immediate (mask preserves, see s3/andBShort7); ≥8 is
    // [Rwi]/[Rwi+] INDIRECT memory addressing — a runtime combine, not a
    // compile-time mask — and must kill like s9's ANDB reg,mem.
    const buf = image();
    let o = CODE;
    o = emit(buf, o, ...loadB(0x0274));
    o = emit(buf, o, 0x69, 0x48); // ANDB rb4,[Rw0] — reg 4 high nibble, low nibble 8 = indirect
    o = emit(buf, o, ...cmpBImm(0x07));
    const out = detectMs41Params(buf, cfg);
    const p = out.find((d) => d.address === saToFo(0x0274))!;
    expect(p).toBeDefined(); // param still emitted (S* membership unaffected)
    expect(p.states).toBeUndefined(); // register clobbered by the indirect AND — no phantom state
  });
});
