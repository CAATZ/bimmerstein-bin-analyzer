/**
 * Switch UI logic — the desktop's single import point for switch helpers
 * (the curvedata.ts precedent): components import from HERE, never from
 * @binanalyzer/core directly. Both helpers are pure and never throw; all
 * byte decoding stays out of components.
 */
export { isSwitch, matchSwitchState } from '@binanalyzer/core';
