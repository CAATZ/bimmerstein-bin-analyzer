import { createHash } from 'node:crypto';
import type { MapDef } from '@binanalyzer/core';

/**
 * Shared test-only canon: the byte-identity fingerprint of a detection list
 * (addresses, dims, formats, axis addresses). Used by parity.test.ts (fixture
 * digests) and scan-partial-curves.test.ts (pre-change canon pins) — one
 * definition so the two can never drift apart.
 */
export function canonDigest(maps: MapDef[]): { count: number; digest: string } {
  const canon = maps
    .map(
      (m) =>
        `${m.address}:${m.rows}x${m.cols}:${m.format.width}${m.format.endianness}:${m.xAxis?.address ?? '-'}:${m.yAxis?.address ?? '-'}`
    )
    .join('|');
  return { count: maps.length, digest: createHash('sha256').update(canon).digest('hex') };
}
