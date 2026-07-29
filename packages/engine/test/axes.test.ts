import { describe, expect, it } from 'vitest';
import { scanAxes } from '../src/axes.js';
import { DEFAULT_SCAN_CONFIG } from '../src/config.js';
import type { Region } from '../src/regions.js';

function putU16be(bytes: Uint8Array, offset: number, values: number[]): void {
  values.forEach((v, i) => {
    bytes[offset + 2 * i] = v >> 8;
    bytes[offset + 2 * i + 1] = v & 0xff;
  });
}

describe('scanAxes', () => {
  it('finds a planted ascending u16be axis', () => {
    const bytes = new Uint8Array(256); // zeros break monotonicity around the plant
    const axis = [520, 760, 1000, 1500, 2000, 2520, 3000, 3520, 4000, 4520, 5000, 5520];
    putU16be(bytes, 64, axis);
    const regions: Region[] = [{ start: 0, end: 256, kind: 'data' }];
    const found = scanAxes(bytes, regions, DEFAULT_SCAN_CONFIG);
    const hit = found.find(
      (a) => a.address === 64 && a.count === 12 && a.format.width === 2 && a.format.endianness === 'big'
    );
    expect(hit).toBeDefined();
    expect(hit!.direction).toBe('inc');
    expect(hit!.score).toBeGreaterThan(0.3);
  });
  it('ignores non-data regions and rejects short runs', () => {
    const bytes = new Uint8Array(64);
    putU16be(bytes, 0, [100, 200, 300]); // length 3 < minCount 4
    const found = scanAxes(bytes, [{ start: 0, end: 64, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    expect(found.find((a) => a.address === 0 && a.count === 3)).toBeUndefined();
    const foundCode = scanAxes(bytes, [{ start: 0, end: 64, kind: 'code' }], DEFAULT_SCAN_CONFIG);
    expect(foundCode).toEqual([]);
  });
  it('penalizes counter-like runs (delta always 1)', () => {
    const bytes = new Uint8Array(64);
    putU16be(bytes, 0, [1, 2, 3, 4, 5, 6, 7, 8]);
    putU16be(bytes, 32, [100, 250, 400, 700, 900, 1300, 1450, 1800]);
    const found = scanAxes(bytes, [{ start: 0, end: 64, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    const counter = found.find((a) => a.address === 0 && a.format.width === 2 && a.format.endianness === 'big');
    const axis = found.find((a) => a.address === 32 && a.format.width === 2 && a.format.endianness === 'big');
    expect(counter).toBeDefined();
    expect(axis).toBeDefined();
    expect(axis!.score).toBeGreaterThan(counter!.score);
  });

  it('does not trim on coincidental value equality when the predecessor is not fill (domain-realism)', () => {
    // Two adjacent real breakpoints happen to share a value (e.g. two tables
    // both referencing a 4000 RPM breakpoint) — NOT padding. values[1] here
    // (4000) equals values[0] (also 4000, a genuine prior sample, encoded as
    // 0x0F,0xA0 — not a 0x00/0xFF fill pattern), so the plateau-trim must NOT
    // fire just because the numbers happen to match.
    const bytes = new Uint8Array(64);
    putU16be(bytes, 0, [4000, 4000, 4500, 5000, 5500, 6000]);
    const found = scanAxes(bytes, [{ start: 0, end: 64, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    // Untrimmed run starts at index 1 (address 2), keeping the leading 4000,
    // count 5. It must NOT be silently amputated to start at index 2 (address
    // 4, count 4) just because 4000 === 4000.
    const untrimmed = found.find(
      (a) => a.address === 2 && a.count === 5 && a.format.width === 2 && a.format.endianness === 'big'
    );
    const trimmed = found.find(
      (a) => a.address === 4 && a.count === 4 && a.format.width === 2 && a.format.endianness === 'big'
    );
    expect(untrimmed).toBeDefined();
    expect(trimmed).toBeUndefined();
  });

  it('keeps a run at exactly minCount when the coincidental predecessor is not a real fill byte', () => {
    // [100, 100, 100, 500, 1000, 1500]: the maximal monotone run is
    // [100, 500, 1000, 1500] (count 4 === minCount). The old "equals
    // immediately preceding value" trim rule fired here (100 === 100) and
    // amputated the leading 100, dropping the run to count 3 — below
    // minCount — so emit() silently discarded the ENTIRE candidate with no
    // diagnostic. 100 encodes as bytes 0x00,0x64: the high byte is 0x00 but
    // the low byte (0x64) is not, so this is NOT a canonical all-0x00/all-0xFF
    // fill pattern. The narrower, byte-pattern-based trim must not fire here,
    // so the full count-4 run is kept and emitted intact (deliberate,
    // documented tradeoff: only a literal fill-byte predecessor is trimmed).
    const bytes = new Uint8Array(64);
    putU16be(bytes, 0, [100, 100, 100, 500, 1000, 1500]);
    const found = scanAxes(bytes, [{ start: 0, end: 64, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    const hit = found.find(
      (a) => a.address === 4 && a.count === 4 && a.format.width === 2 && a.format.endianness === 'big'
    );
    expect(hit).toBeDefined();
    expect(hit!.direction).toBe('inc');
  });

  it('finds axes at odd byte offsets (phase probing)', () => {
    const bytes = new Uint8Array(64);
    putU16be(bytes, 21, [500, 900, 1300, 1700, 2100]); // odd address, deltas 400
    putU16be(bytes, 40, [600, 1000, 1400, 1800]); // even control
    const found = scanAxes(bytes, [{ start: 0, end: 64, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    const odd = found.find((a) => a.address === 21 && a.count === 5 && a.format.width === 2);
    const even = found.find((a) => a.address === 40 && a.count === 4 && a.format.width === 2);
    expect(odd).toBeDefined();
    expect(odd!.direction).toBe('inc');
    expect(even).toBeDefined();
  });
});
