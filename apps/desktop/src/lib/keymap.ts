/**
 * THE keyboard dispatcher (one module, no per-component global keydowns).
 * The v1 map is FROZEN in spec §7:
 *   M/W columns ± · Ctrl+←/→ origin · K selection→map / promote ·
 *   Ctrl+B optimize value range · F/Shift+F next/prev potential ·
 *   T/Shift+T cycle view · P preview · Ctrl+Z/Ctrl+Shift+Z undo/redo
 *   (undo added 2026-08-01 with the undo stack; spec §7 amended in the same task).
 *   '+'/'-' step the selection by one raw LSB · F11 show original values
 *   (v2 Part B1 claimed the keys v1 reserved; spec 2026-08-09-map-value-editing).
 * Pure: KeyInput in, action name out; the App shell maps names to store actions.
 */

export type UiAction =
  | 'columns-inc'
  | 'columns-dec'
  | 'origin-left'
  | 'origin-right'
  | 'confirm-selection'
  | 'optimize-range'
  | 'next-potential'
  | 'prev-potential'
  | 'view-next'
  | 'view-prev'
  | 'toggle-preview'
  | 'undo'
  | 'redo'
  | 'value-inc'
  | 'value-dec'
  | 'toggle-original';

export interface KeyInput {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** True when focus is in an input/select/textarea/contenteditable. */
  inEditable: boolean;
}

export function resolveKey(k: KeyInput): UiAction | undefined {
  if (k.inEditable || k.alt || k.meta) return undefined;
  if (k.ctrl) {
    if (k.key === 'ArrowLeft') return 'origin-left';
    if (k.key === 'ArrowRight') return 'origin-right';
    if (k.key === 'b' || k.key === 'B') return 'optimize-range';
    if (k.key === 'z' || k.key === 'Z') return k.shift ? 'redo' : 'undo';
    return undefined;
  }
  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
  switch (key) {
    case 'm':
      return 'columns-inc';
    case 'w':
      return 'columns-dec';
    case 'k':
      return 'confirm-selection';
    case 'f':
      return k.shift ? 'prev-potential' : 'next-potential';
    case 't':
      return k.shift ? 'view-prev' : 'view-next';
    case 'p':
      return 'toggle-preview';
    case '+':
      return 'value-inc';
    case '-':
      return 'value-dec';
    case 'F11':
      return 'toggle-original';
    default:
      return undefined;
  }
}
