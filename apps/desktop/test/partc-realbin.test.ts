import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from 'svelte/store';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBinImage, readValue, sha256Hex, type MapDef } from '@binanalyzer/core';
import { applyProposal, dispatchOp } from '../src/copilot/dispatch.js';
import * as a from '../src/store/actions.js';
import { checksumReport, editJournal, proposals, workingBytes } from '../src/store/stores.js';
import { clearUndo, undo } from '../src/store/undo.js';

/**
 * Part C on REAL firmware.
 *
 * Everything else in this suite runs on synthetic buffers. This one drives the
 * co-pilot's byte path over an actual MS41 full read, so the claims that matter
 * — a cal edit really does invalidate a real checksum, and the two transfers
 * really do differ in exactly the edited byte — are measured rather than
 * inferred.
 *
 * SKIPPED when the firmware is absent, which is how CI runs: real ECU images
 * are never committed (fixtures/README.md).
 */
const BIN = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'ms41', 'E36 M3 Stock Full Read.bin');
const HAVE_BIN = existsSync(BIN);

/** Inside the MS41 full-read cal window fo(SA) = (0x10000+SA)^0x4000. */
const CAL = 0x1673c;

const map: MapDef = {
  id: 'm-cal', name: 'Cal probe', address: CAL, rows: 1, cols: 4,
  format: { width: 1, signed: false, endianness: 'little' },
  scaling: { factor: 0.75, offset: 0, units: '°', digits: 2 },
  orientation: 'row-major', provenance: 'manual',
};

describe.skipIf(!HAVE_BIN)('Part C on a real MS41 full read', () => {
  let originalRaw = 0;

  beforeAll(() => {
    expect(HAVE_BIN).toBe(true);
  });

  const seed = (): void => {
    a.resetStores();
    a.setBin(createBinImage(new Uint8Array(readFileSync(BIN)), 'E36 M3 Stock Full Read.bin'));
    a.runChecksumVerify();
    expect(a.addImportedMaps([map]).added).toBe(1);
    clearUndo();
    originalRaw = readValue(get(workingBytes)!, CAL, map.format);
  };

  it('applies a matching row, fails a stale one alone, and goes checksum-stale', () => {
    seed();
    expect(get(checksumReport)?.valid).toBe(true);

    proposals.set([{
      requestId: 'r1', title: 'real acceptance',
      changes: [
        { id: 'e1', kind: 'cell', mapId: map.id, row: 0, col: 0, value: originalRaw ^ 0x0f, raw: true, expectedRaw: originalRaw },
        { id: 'e2', kind: 'cell', mapId: map.id, row: 0, col: 1, value: 1, raw: true, expectedRaw: 999 },
      ],
    }]);
    const outcome = applyProposal('r1', ['e1', 'e2']);

    expect(outcome.accepted).toEqual(['e1']);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.error).toContain('999');
    expect(readValue(get(workingBytes)!, CAL, map.format)).toBe(originalRaw ^ 0x0f);
    expect(get(editJournal).size).toBe(1);
    // A real calibration checksum genuinely covers this byte.
    expect(get(checksumReport)?.valid).toBe(false);
  });

  it('is ONE undo step that restores the buffer and the verdict', () => {
    seed();
    proposals.set([{
      requestId: 'r2', title: 'undo',
      changes: [{ id: 'e1', kind: 'cell', mapId: map.id, row: 0, col: 0, value: originalRaw ^ 0x0f, raw: true, expectedRaw: originalRaw }],
    }]);
    applyProposal('r2', ['e1']);
    expect(get(checksumReport)?.valid).toBe(false);

    expect(undo()).toBe(true);
    expect(readValue(get(workingBytes)!, CAL, map.format)).toBe(originalRaw);
    expect(get(editJournal).size).toBe(0);
    expect(undo()).toBe(false);
  });

  it('serves two buffers that differ in exactly the edited byte, each under its own hash', async () => {
    seed();
    const image = get(workingBytes)!;
    const binSha = sha256Hex(image);

    proposals.set([{
      requestId: 'r3', title: 'transfer',
      changes: [{ id: 'e1', kind: 'cell', mapId: map.id, row: 0, col: 0, value: originalRaw ^ 0x0f, raw: true, expectedRaw: originalRaw }],
    }]);
    applyProposal('r3', ['e1']);

    const working = await dispatchOp('getBinBytes', {});
    const original = await dispatchOp('getBinBytes', { which: 'original' });
    expect(working.ok && original.ok).toBe(true);
    if (!working.ok || !original.ok) return;

    const w = Uint8Array.from(atob(working.value['base64'] as string), (c) => c.charCodeAt(0));
    const o = Uint8Array.from(atob(original.value['base64'] as string), (c) => c.charCodeAt(0));

    // Each transfer hashes WHAT IT SENT.
    expect(working.value['sha256']).toBe(sha256Hex(w));
    expect(original.value['sha256']).toBe(sha256Hex(o));
    // The original is the file as opened; the working buffer is not.
    expect(original.value['sha256']).toBe(binSha);
    expect(working.value['sha256']).not.toBe(binSha);

    let differing = 0;
    for (let i = 0; i < o.length; i++) if (w[i] !== o[i]) differing++;
    expect(differing).toBe(1);
    expect(w[CAL]).toBe(originalRaw ^ 0x0f);
    expect(o[CAL]).toBe(originalRaw);
  });
});
