import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import { saToFo } from '../src/family/ms41/frame.js';
import { scanPlateauCalAxes } from '../src/family/ms41/plateau.js';

function putSA(bytes: Uint8Array, sa: number, vals: number[]): void {
  for (let i = 0; i < vals.length; i++) bytes[saToFo(sa + i)] = vals[i]!;
}
const u8 = { width: 1, signed: false, endianness: 'big' } as const;
const u16le = { width: 2, signed: false, endianness: 'little' } as const;

describe('scanPlateauCalAxes', () => {
  it('finds a u8 plateau axis (count includes the tail — the 0x4000 law)', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0x900, [20, 10, 20, 30, 40, 50, 60, ...Array.from({ length: 14 }, () => 60)]);
    expect(scanPlateauCalAxes(bytes, DEFAULT_SCAN_CONFIG)).toContainEqual({
      address: saToFo(0x901),
      end: saToFo(0x901) + 20,
      count: 20,
      format: u8,
    });
  });

  it('finds a u16 LE plateau axis (the 0x3636 law)', () => {
    const bytes = new Uint8Array(0x18000);
    const vals = [20, 0];
    for (let v = 500; v <= 2000; v += 100) vals.push(v & 0xff, v >> 8); // 16 ascending
    for (let i = 0; i < 4; i++) vals.push(2000 & 0xff, 2000 >> 8); // tail ×4
    putSA(bytes, 0xa00, vals);
    expect(scanPlateauCalAxes(bytes, DEFAULT_SCAN_CONFIG)).toContainEqual({
      address: saToFo(0xa02),
      end: saToFo(0xa02) + 40,
      count: 20,
      format: u16le,
    });
  });

  it('includes a NON-maximal strict run (the 0x35AE quirk — no maximality requirement)', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0xb00, [4, 10, 20, 30, 40, 50]); // run keeps ascending past the count
    expect(scanPlateauCalAxes(bytes, DEFAULT_SCAN_CONFIG)).toContainEqual({
      address: saToFo(0xb01),
      end: saToFo(0xb01) + 4,
      count: 4,
      format: u8,
    });
  });

  it('excludes dead runs and short strict prefixes', () => {
    const bytes = new Uint8Array(0x18000);
    putSA(bytes, 0xc00, [4, 7, 7, 7, 7]); // dead
    putSA(bytes, 0xd00, [8, 10, 20, 30, 30, 30, 30, 30, 30]); // strict prefix 3 < 4
    const found = scanPlateauCalAxes(bytes, DEFAULT_SCAN_CONFIG);
    expect(found.filter((p) => p.address === saToFo(0xc01))).toEqual([]);
    expect(found.filter((p) => p.address === saToFo(0xd01))).toEqual([]);
  });
});
