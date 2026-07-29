import { describe, expect, it } from 'vitest';
import { parseGroundTruth } from '../src/groundtruth.js';

const valid = JSON.stringify({
  fixture: 'synth-1',
  binSha256: 'a'.repeat(64),
  maps: [
    {
      id: 'gt-1', name: 'Planted 6x8', address: 9028, rows: 6, cols: 8,
      format: { width: 2, signed: false, endianness: 'big' },
      scaling: { factor: 1, offset: 0, units: '', digits: 0 },
      orientation: 'row-major', provenance: 'imported',
      xAxis: { kind: 'referenced', count: 8, address: 9000, format: { width: 2, signed: false, endianness: 'big' } },
    },
  ],
});

describe('parseGroundTruth', () => {
  it('parses a valid document', () => {
    const r = parseGroundTruth(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.maps).toHaveLength(1);
  });
  it('rejects malformed JSON, wrong sha, missing fields', () => {
    expect(parseGroundTruth('{oops').ok).toBe(false);
    expect(parseGroundTruth(JSON.stringify({ fixture: 'x', binSha256: 'short', maps: [] })).ok).toBe(false);
    expect(parseGroundTruth(JSON.stringify({ fixture: 'x', binSha256: 'a'.repeat(64), maps: [{ name: 'no addr' }] })).ok).toBe(false);
  });
});
