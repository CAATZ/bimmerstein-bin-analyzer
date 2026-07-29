import type { Scaling } from './types.js';

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
