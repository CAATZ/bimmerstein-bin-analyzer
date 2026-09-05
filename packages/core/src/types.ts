/**
 * Core data model for BimmerStein Bin Analyzer.
 * Source of truth: the v1 design spec §3 (internal notes).
 * Changing anything here requires updating the spec in the same commit.
 */

/** Tuner convention: LoHi = 'little', HiLo = 'big'. */
export type Endianness = 'little' | 'big';

export interface ValueFormat {
  /** Bytes per cell. */
  width: 1 | 2 | 4;
  signed: boolean;
  /** Ignored for width 1. */
  endianness: Endianness;
  /** Width-4 IEEE 754 single precision. */
  float?: boolean;
}

/**
 * physical = raw * factor + offset.
 * Non-affine imported expressions are preserved in rawExpression and the UI
 * falls back to raw display with a warning — never silently mis-scale.
 */
export interface Scaling {
  factor: number;
  offset: number;
  units: string;
  digits: number;
  rawExpression?: string;
}

export interface AxisDef {
  /**
   * 'referenced' = axis values stored in the bin at `address`;
   * 'literal'    = axis values carried in the definition itself (RomRaider
   *                static axes) — stored in `values`, no bin address;
   * 'index'      = 0,1,2,… (no axis data at all).
   */
  kind: 'referenced' | 'literal' | 'index';
  address?: number;
  count: number;
  /** Required when kind === 'literal'; length === count. */
  values?: number[];
  format?: ValueFormat;
  scaling?: Scaling;
  name?: string;
  /**
   * Axis Library stamp marker (2026-07-29 shared-axis-library spec §2): id of
   * the AxisLibEntry this axis was stamped from. Pure metadata — no exporter
   * reads it; it persists only via the project file; a dangling libId is
   * cleared on load, never an error (the inline copy is self-sufficient).
   */
  libId?: string;
}

/**
 * One Axis Library entry (2026-07-29 shared-axis-library spec §2): define an
 * axis once, stamp inline copies onto many maps. The stored axis is kind
 * 'referenced' | 'literal' only, carries no libId of its own, and any inner
 * name is ignored — entry.name is authoritative (stamped as axis.name).
 */
export interface AxisLibEntry {
  /** Unique within the project; minted app-side via crypto.randomUUID(). */
  id: string;
  /** Non-empty display name; stamped onto attached axes. */
  name: string;
  axis: AxisDef;
  notes?: string;
}

export type Provenance = 'auto' | 'manual' | 'imported';

/**
 * Which detection tier produced an auto-detected map (spec §4.5/§4.6), ordered
 * by precedence: `family` = family-specific analysis, combining code references
 * and structural fallbacks; `structural` = placed from a
 * count-prefixed axis pair's stored lengths (pool.ts); `pool` = byte-detected
 * and bound to a shared count-prefixed axis pair; `generic` = pure byte-
 * smoothness heuristic. Only valid on `provenance === 'auto'` maps (the engine
 * sets it on every auto detection). The tier identifies the detection method;
 * it does not certify an exact address or prove a code reference.
 */
export type DetectorTier = 'family' | 'structural' | 'pool' | 'generic';

/** One named byte-pattern a Switch table can hold (RomRaider <state>). */
export interface SwitchState {
  name: string;
  /** Raw byte values (integers 0..255); length === rows*cols*format.width of the owning map. */
  data: number[];
}

export interface MapDef {
  /**
   * Stable unique id. Auto-detected maps use a deterministic
   * address/shape-derived id (the engine forbids randomness);
   * user-created/imported maps may use UUIDs.
   */
  id: string;
  name: string;
  category?: string;
  /** Absolute byte offset of the first data cell. */
  address: number;
  /** 1 for curves (1D). */
  rows: number;
  cols: number;
  format: ValueFormat;
  scaling: Scaling;
  orientation: 'row-major' | 'col-major';
  /** length must equal cols (row-major). */
  xAxis?: AxisDef;
  /** length must equal rows. */
  yAxis?: AxisDef;
  provenance: Provenance;
  /** 0..1, present iff provenance === 'auto'. */
  confidence?: number;
  /** Detection tier that produced this map; set iff provenance === 'auto'. */
  detector?: DetectorTier;
  /**
   * Named byte-pattern states — present ⇔ this map is a SWITCH table
   * (RomRaider type="Switch"). Canonical switch shape, enforced by
   * validateMapDef: cols === 1, format.width === 1 (u8), no axes; rows is the
   * switch's byte count. v1 is read-only: states are MATCHED against the bin
   * for display, never written.
   */
  states?: SwitchState[];
  notes?: string;
}

export interface BinImage {
  bytes: Uint8Array;
  sha256: string;
  size: number;
  /** Display only — never used for identity. */
  name: string;
}

export interface Project {
  /**
   * 3 since project lineage (2026-08-24): writers emit 3 unconditionally;
   * parseProject accepts 1, 2 AND 3, normalizing older versions on load.
   */
  schemaVersion: 1 | 2 | 3;
  /** Bin referenced by identity, never embedded. */
  bin: { name: string; sha256: string; size: number };
  /**
   * The image that was OPEN when this project was saved, when that differs
   * from `bin` — the base a tune was built on.
   *
   * Name AND sha: the name is what makes this readable a year later, the sha is
   * what makes it checkable if the file is still around. Absent when `bin` IS
   * the image as opened, because `derivedFrom === bin` is noise, not provenance.
   */
  derivedFrom?: { name: string; sha256: string };
  /** View defaults (e.g. MS41: width 2, big-endian). */
  valueDefaults: ValueFormat;
  /**
   * How imported definition addresses were mapped into file offsets:
   * 'ms41full' = fo(SA) = (0x10000+SA)^0x4000 flash-bus frame (spec
   * 2026-07-14-fullread-def-frame-design). Absent = no mapping (24KB CAL).
   */
  addressFrame?: 'ms41full';
  /** Axis Library (schemaVersion 2). Absent ≡ empty. */
  axisLibrary?: AxisLibEntry[];
  /** User-confirmed maps. */
  maps: MapDef[];
  /** Auto-detected, unconfirmed (provenance 'auto'). */
  potentialMaps: MapDef[];
}

/** Typed result used across all package boundaries — parsing never throws. */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Single source of ECU-family identity. A family is described in two packages —
 * detection in packages/engine, byte semantics (checksums) in
 * packages/families — and neither may import the other. Both test their
 * registries against this list, so adding an id here fails both suites until
 * both halves exist or explicitly opt out.
 */
export const FAMILY_IDS = ['ms41'] as const;
export type FamilyId = (typeof FAMILY_IDS)[number];

/**
 * The drift rule both registries are checked against, in one place so it can be
 * tested against lists that actually disagree.
 *
 * With a single declared family neither suite can drive its own check to a
 * non-empty result, so each would pass even if the rule were inverted. Sharing
 * the rule lets core exercise it with synthetic lists while engine and families
 * each apply it to the registry they own.
 *
 * `missing`    — declared in FAMILY_IDS, no implementation, no opt-out.
 * `undeclared` — an implementation exists for an id core never declared.
 */
export function familyCoverageGaps(
  declared: readonly string[],
  implemented: readonly string[],
  optedOut: readonly string[] = []
): { missing: string[]; undeclared: string[] } {
  const have = new Set(implemented);
  const known = new Set(declared);
  return {
    missing: declared.filter((id) => !have.has(id) && !optedOut.includes(id)),
    undeclared: implemented.filter((id) => !known.has(id)),
  };
}
