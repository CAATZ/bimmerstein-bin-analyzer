import type { Scaling } from './types.js';
import type { ValueFormat } from './types.js';

/**
 * physical = raw * factor + offset; toPhysical/toRaw are exact inverses for
 * affine scalings. When scaling.rawExpression is set (non-affine import),
 * toPhysical returns the raw value unchanged — callers must surface the
 * "unscaled" warning. Implemented in plan Phase 1 (TDD).
 */
export function toPhysical(raw: number, scaling: Scaling): number {
  if (scaling.rawExpression !== undefined) return raw;
  return raw * scaling.factor + scaling.offset;
}

export function formatPhysical(raw: number, scaling: Scaling): string {
  return toPhysical(raw, scaling).toFixed(Math.max(0, Math.trunc(scaling.digits)));
}

/**
 * Inverse of toPhysical. Unrounded and unclamped — quantise does that part.
 * Mirrors toPhysical's rawExpression rule: a non-affine imported expression
 * displays the raw value, so its inverse is the identity too.
 */
export function toRaw(physical: number, scaling: Scaling): number {
  if (scaling.rawExpression !== undefined) return physical;
  return (physical - scaling.offset) / scaling.factor;
}

/** Inclusive representable range of an integer cell format. */
function integerRange(format: ValueFormat): { min: number; max: number } {
  const bits = format.width * 8;
  if (format.signed) return { min: -(2 ** (bits - 1)), max: 2 ** (bits - 1) - 1 };
  return { min: 0, max: 2 ** bits - 1 };
}

/** Round half AWAY FROM ZERO, so +0.5 and -0.5 step symmetrically. */
const roundHalfAway = (v: number): number =>
  v < 0 ? -Math.round(-v) : Math.round(v);

/**
 * What will ACTUALLY be stored for a typed physical value.
 *
 * This is the honesty seam of the edit model: a typed value is usually not
 * exactly storable (with a factor of 0.0078125 almost nothing a human types
 * is), so the caller must redisplay `physical` rather than echoing the input.
 *
 * - float cells are continuous: no integer rounding, only finite clamping.
 * - a zero factor cannot be inverted; `editable: false` says so instead of
 *   producing Infinity.
 */
export function quantise(
  physical: number,
  scaling: Scaling,
  format: ValueFormat
): { stored: number; physical: number; clamped: boolean; editable: boolean } {
  if (scaling.rawExpression === undefined && scaling.factor === 0) {
    return { stored: 0, physical: 0, clamped: false, editable: false };
  }
  const raw = toRaw(physical, scaling);
  if (format.float === true) {
    const stored = Number.isFinite(raw) ? Math.fround(raw) : 0;
    return { stored, physical: toPhysical(stored, scaling), clamped: false, editable: true };
  }
  const { min, max } = integerRange(format);
  const rounded = roundHalfAway(raw);
  const stored = Math.min(max, Math.max(min, rounded));
  return {
    stored,
    physical: toPhysical(stored, scaling),
    clamped: stored !== rounded,
    editable: true,
  };
}
