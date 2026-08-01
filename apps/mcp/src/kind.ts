import { isParamShaped, isSwitch, type MapDef } from '@binanalyzer/core';
import { isCurveShaped } from '@binanalyzer/formats';

export type MapKind = 'switch' | 'param' | 'curve' | 'grid';

/**
 * Shape classification in the app's own precedence — switch is checked BEFORE
 * curve (Switch Phase A), and a 1x1 states-bearing map is a switch, never a
 * param. param (1x1) and curve (exactly one of rows/cols is 1) are disjoint.
 */
export function mapKind(map: Pick<MapDef, 'rows' | 'cols' | 'states'>): MapKind {
  if (isSwitch(map)) return 'switch';
  if (isParamShaped(map)) return 'param';
  if (isCurveShaped(map)) return 'curve';
  return 'grid';
}
