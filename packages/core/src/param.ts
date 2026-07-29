import type { MapDef } from './types.js';
import { isSwitch } from './switch.js';

/**
 * 1×1 scalar/parameter shape (spec 2026-07-23 Switch Phase B). Shape-derived
 * like isSwitch/isCurveShaped — NOT tied to provenance or detector, so an
 * imported 1×1 def scalar and an auto code-referenced parameter both qualify.
 * States win: a 1×1 states-bearing map is a switch, never a param.
 */
export function isParamShaped(map: Pick<MapDef, 'rows' | 'cols' | 'states'>): boolean {
  return map.rows === 1 && map.cols === 1 && !isSwitch(map);
}
