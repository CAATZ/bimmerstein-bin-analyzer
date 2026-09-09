import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import type { ReaderCall } from '../src/family/ms41/c166.js';
import { saToFo } from '../src/family/ms41/frame.js';
import { selfLocateCurveReaders, selfLocateReaders } from '../src/family/ms41/readers.js';

function putSA(bytes: Uint8Array, sa: number, vals: number[]): void {
  for (let i = 0; i < vals.length; i++) bytes[saToFo(sa + i)] = vals[i]!;
}

/**
 * Image with one shared axis pair and five header-backed table SAs
 * (0x300,0x340,…,0x400), plus a byte-reader body (A9) at CPU 0x1000.
 */
function buildImage(): { bytes: Uint8Array; sas: number[] } {
  const bytes = new Uint8Array(0x18000);
  putSA(bytes, 0x100, [6, 10, 20, 30, 40, 50, 60]); // x axis, count 6
  putSA(bytes, 0x200, [4, 50, 60, 70, 80]); // y axis, count 4
  const sas = [0x300, 0x340, 0x380, 0x3c0, 0x400];
  for (const sa of sas) putSA(bytes, sa - 4, [0x00, 0x01, 0x00, 0x02]); // [xPtr 0x100][yPtr 0x200]
  bytes.set([0xa9, 0x24], 0x5000); // byte-reader body at cpu 0x1000
  bytes.set([0xa8, 0x24], 0x5100); // word-reader body at cpu 0x1100
  return { bytes, sas };
}

const call = (targetCpu: number, sa: number): ReaderCall => ({ siteFile: 0, targetCpu, sa, dist: 0 });

describe('selfLocateReaders', () => {
  it('selects targets whose args are header-backed, with classified width', () => {
    const { bytes, sas } = buildImage();
    const calls = [
      ...sas.map((sa) => call(0x1000, sa)), // 5 distinct header-valid args
      ...[0x500, 0x510, 0x520, 0x530, 0x540].map((sa) => call(0x2000, sa)), // 5 headerless args
    ];
    expect(selfLocateReaders(bytes, calls, DEFAULT_SCAN_CONFIG, 5, 0.5, 40)).toEqual([
      { target: 0x1000, width: 1 },
    ]);
  });

  it('rejects targets below the min-args floor', () => {
    const { bytes, sas } = buildImage();
    const calls = sas.slice(0, 4).map((sa) => call(0x1000, sa)); // only 4 distinct args
    expect(selfLocateReaders(bytes, calls, DEFAULT_SCAN_CONFIG, 5, 0.5, 40)).toEqual([]);
  });

  it('counts DISTINCT args (repeat call sites do not inflate the floor)', () => {
    const { bytes, sas } = buildImage();
    const calls = Array.from({ length: 10 }, () => call(0x1000, sas[0]!)); // 10 sites, 1 distinct arg
    expect(selfLocateReaders(bytes, calls, DEFAULT_SCAN_CONFIG, 5, 0.5, 40)).toEqual([]);
  });

  it('rejects targets whose width cannot be classified', () => {
    const { bytes, sas } = buildImage();
    const calls = sas.map((sa) => call(0x3000, sa)); // no fetch body at cpu 0x3000 (zeros)
    expect(selfLocateReaders(bytes, calls, DEFAULT_SCAN_CONFIG, 5, 0.5, 40)).toEqual([]);
  });

  it('returns entries sorted by target and classifies word readers', () => {
    const { bytes, sas } = buildImage();
    const calls = [
      ...sas.map((sa) => call(0x1100, sa)),
      ...sas.map((sa) => call(0x1000, sa)),
    ];
    expect(selfLocateReaders(bytes, calls, DEFAULT_SCAN_CONFIG, 5, 0.5, 40)).toEqual([
      { target: 0x1000, width: 1 },
      { target: 0x1100, width: 2 },
    ]);
  });

  it('accepts a target exactly at the header-rate floor (rate === rateMin)', () => {
    const { bytes } = buildImage();
    const calls = [
      call(0x1000, 0x300), // header-backed
      call(0x1000, 0x340), // header-backed
      call(0x1000, 0x500), // headerless
      call(0x1000, 0x510), // headerless
    ];
    // 4 distinct args, 2/4 header-backed => rate exactly 0.5 === rateMin
    expect(selfLocateReaders(bytes, calls, DEFAULT_SCAN_CONFIG, 4, 0.5, 40)).toEqual([{ target: 0x1000, width: 1 }]);
  });
});

describe('selfLocateCurveReaders', () => {
  it('excludes a descriptor stager whose preceding values resemble curve headers', () => {
    const { bytes } = buildImage();
    putSA(bytes, 0x150, [4, 1, 2, 3, 4]);
    const sas = [0x600, 0x640, 0x680, 0x6c0, 0x700];
    for (const sa of sas) putSA(bytes, sa - 2, [0x50, 0x01]);
    // Load the descriptor pointer, fetch its count, and publish the axis index.
    bytes.set([0xa8, 0x3c, 0x99, 0x43, 0xf7, 0xf4, 0x40, 0xf1, 0xdb, 0x00], 0x5200);
    bytes.set([0xa8, 0x24, 0xdb, 0x00], 0x5300);
    const calls = sas.flatMap(sa => [call(0x1200, sa), call(0x1300, sa)]);
    expect(selfLocateCurveReaders(bytes, calls, DEFAULT_SCAN_CONFIG)).toEqual(new Map([[0x1300, 2]]));
  });

  it('excludes a grid reader (4-byte header) and includes a header-backed non-grid target, with classified width', () => {
    // Grid target cpu 0x1000: 5 args, each with a full 4-byte [xPtr][yPtr] header at sa-4.
    // KEY MECHANISM: that layout places the yPtr u16 exactly at sa-2, and yPtr (0x200) is a
    // backward pointer (0x200 < 0x300..0x400) to a valid axis run — so the grid target PASSES
    // the bare 2-byte backward-header test too (readU16SA(sa-2) = 0x200, validateAxisPtr
    // succeeds on the y axis). Without the gridTrio subtraction in selfLocateCurveReaders it
    // WOULD be emitted as a curve reader and both assertions below would fail; the subtraction
    // is the load-bearing exclusion this test pins.
    const { bytes, sas } = buildImage();
    // Curve axis (count == curveAxisMinCount 4), strictly monotone, unused SA region.
    putSA(bytes, 0x150, [4, 1, 2, 3, 4]);
    // Curve target: 5 distinct args whose sa-2 backward pointer is the curve axis above; sa-4 is left
    // zeroed (0 < MS41_CAL_SA_MIN), so it fails the grid's 4-byte header test and selfLocateReaders will
    // not pick it up as a grid reader.
    const curveSas = [0x600, 0x640, 0x680, 0x6c0, 0x700];
    for (const sa of curveSas) putSA(bytes, sa - 2, [0x50, 0x01]); // LE(0x150)
    bytes.set([0xa8, 0x24], 0x5200); // word-reader body at cpu 0x1200

    const calls = [
      ...sas.map((sa) => call(0x1000, sa)), // grid reader: full 4-byte headers -> also valid 2-byte headers
      ...curveSas.map((sa) => call(0x1200, sa)), // curve reader: 2-byte backward header only
    ];

    const result = selfLocateCurveReaders(bytes, calls, DEFAULT_SCAN_CONFIG);
    expect(result.has(0x1000)).toBe(false); // grid reader excluded (owned by the 2-axis tier)
    expect(result).toEqual(new Map([[0x1200, 2]]));
  });

  it('excludes a target whose sa-2 pointers are FORWARD (ptr >= sa) even when the pointee validates', () => {
    const { bytes } = buildImage();
    // Valid axis AHEAD of every arg: count 4 == curveAxisMinCount, strictly monotone.
    putSA(bytes, 0x900, [4, 1, 2, 3, 4]);
    // 5 distinct args (== curveReaderMinArgs) whose sa-2 holds LE(0x900) — a pointer that
    // validateAxisPtr WOULD accept, but which points forward (0x900 > every sa). Only the
    // ptr < sa backward guard in selfLocateCurveReaders keeps hdr at 0/5; without it the
    // rate would be 5/5 and the target (classifiable byte-reader body) would be emitted.
    const fwdSas = [0x800, 0x840, 0x880, 0x8c0, 0x8f0];
    for (const sa of fwdSas) putSA(bytes, sa - 2, [0x00, 0x09]); // LE(0x900), ptr > sa
    bytes.set([0xa9, 0x24], 0x5300); // byte-reader body at cpu 0x1300 (width IS classifiable)
    const calls = fwdSas.map((sa) => call(0x1300, sa));
    expect(selfLocateCurveReaders(bytes, calls, DEFAULT_SCAN_CONFIG)).toEqual(new Map());
  });
});
