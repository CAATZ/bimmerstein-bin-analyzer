import { readValue, type MapDef } from '@binanalyzer/core';
import { frameDefMaps, unframeDefMaps } from '@binanalyzer/appkit';
import type { MapPack, PackTable } from '@binanalyzer/formats';
import type { FamilyIdentity } from '@binanalyzer/families';

/**
 * Applying a map pack, decided per table (spec §4.2). Pure: this module reads
 * bytes and returns a verdict, it never writes. Task 4's applier is the only
 * thing that moves a byte, and it consumes what this produces.
 */
export type PackRowClass = 'ready' | 'modified' | 'no-change' | 'incompatible';

export interface PackRow {
  /** Index into pack.tables — the id the panel checks and apply consumes. */
  index: number;
  name: string;
  /** Address IN THIS BIN's frame, after any conversion. */
  address: number;
  rows: number;
  cols: number;
  klass: PackRowClass;
  /** How many cells the pack would actually change. */
  changedCells: number;
  /** Every cell, for the drill-down. */
  cells: Array<{ row: number; col: number; before: number; after: number }>;
  /** Cells where THIS bin already differs from the author's baseline. */
  divergedCells: Array<{ row: number; col: number; mine: number; theirBaseline: number }>;
  /** Set only when klass === 'incompatible'. */
  reason?: string;
  table: PackTable;
}

/**
 * The CAL-ID gate (spec §4.1). A mismatch refuses the WHOLE pack: within a
 * CAL-ID an address is exact, across one 72-97 % of tables relocate, so there
 * is no honest partial application.
 */
export function packGateError(pack: MapPack, identity: FamilyIdentity | undefined): string | undefined {
  if (identity === undefined) {
    return "this bin's calibration id could not be identified, so the pack cannot be verified against it — nothing was applied";
  }
  if (identity.familyId !== pack.source.familyId) {
    return `this pack is for the ${pack.source.familyId} family; the loaded bin is ${identity.familyId} — nothing was applied`;
  }
  if (identity.calId !== pack.source.calId) {
    return `this pack was built on calibration ${pack.source.calId}; the loaded bin is ${identity.calId}. Table addresses differ between calibrations, so nothing was applied`;
  }
  return undefined;
}

/**
 * Convert one pack address into this bin's frame.
 *
 * Reuses the shipped frameDefMaps/unframeDefMaps rather than re-deriving fo(),
 * so the seam and cal-window guards come along for free. A table the helpers
 * refuse is genuinely un-mappable and becomes `incompatible`, carrying the
 * helper's own reason rather than a generic one.
 */
function reframe(
  t: PackTable,
  packFrame: 'ms41full' | undefined,
  binIsFullRead: boolean
): { address: number } | { error: string } {
  const packIsFull = packFrame === 'ms41full';
  if (packIsFull === binIsFullRead) return { address: t.address };

  const asMap: MapDef = {
    id: 'pack',
    name: t.name,
    address: t.address,
    rows: t.rows,
    cols: t.cols,
    format: t.format,
    scaling: t.scaling,
    orientation: t.orientation,
    provenance: 'manual',
  };
  // pack is full-read, bin is a partial -> file offset back to SA, and vice versa.
  const r = packIsFull ? unframeDefMaps([asMap]) : frameDefMaps([asMap]);
  const out = r.maps[0];
  if (out === undefined) {
    const why = r.skipped[0]?.replace(/^pack \("[^"]*"\): /, '') ?? 'not frameable';
    return { error: `"${t.name}" cannot be mapped into this image's address frame: ${why}` };
  }
  return { address: out.address };
}

/**
 * Decide, per table, what applying this pack to `bytes` would do. Reads only —
 * the caller's buffer is never touched.
 */
export function classifyPack(args: { pack: MapPack; bytes: Uint8Array; binIsFullRead: boolean }): PackRow[] {
  const { pack, bytes, binIsFullRead } = args;
  return pack.tables.map((t, index) => {
    const base = {
      index,
      name: t.name,
      rows: t.rows,
      cols: t.cols,
      table: t,
      changedCells: 0,
      cells: [] as PackRow['cells'],
      divergedCells: [] as PackRow['divergedCells'],
    };

    const framed = reframe(t, pack.source.addressFrame, binIsFullRead);
    if ('error' in framed) {
      return { ...base, address: t.address, klass: 'incompatible' as const, reason: framed.error };
    }
    const address = framed.address;
    const span = t.rows * t.cols * t.format.width;
    if (address < 0 || address + span > bytes.length) {
      return {
        ...base,
        address,
        klass: 'incompatible' as const,
        reason: `"${t.name}" lies outside this bin (needs ${span} bytes at 0x${address.toString(16)})`,
      };
    }

    const cells: PackRow['cells'] = [];
    const diverged: PackRow['divergedCells'] = [];
    let changed = 0;
    for (let r = 0; r < t.rows; r++) {
      for (let c = 0; c < t.cols; c++) {
        const i = t.orientation === 'row-major' ? r * t.cols + c : c * t.rows + r;
        const off = address + i * t.format.width;
        const before = readValue(bytes, off, t.format);
        const after = t.values[r]![c]!;
        const theirBaseline = t.baseline[r]![c]!;
        cells.push({ row: r, col: c, before, after });
        if (before !== after) changed++;
        if (before !== theirBaseline) diverged.push({ row: r, col: c, mine: before, theirBaseline });
      }
    }

    // Divergence outranks everything: if this bin is not what the author built
    // on, the user must be told that before anything else about the table.
    const klass: PackRowClass = diverged.length > 0 ? 'modified' : changed === 0 ? 'no-change' : 'ready';
    return { ...base, address, klass, changedCells: changed, cells, divergedCells: diverged };
  });
}

/**
 * Everything checked except `incompatible`, which can never be applied.
 *
 * `modified` rows ARE checked: unlike Part C's stale cell rows, a modified
 * table is the normal case when someone applies a second pack, so it is
 * flagged loudly rather than silently opted out.
 */
export function initialPackChecked(rows: readonly PackRow[]): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  for (const r of rows) out[r.index] = r.klass !== 'incompatible';
  return out;
}
