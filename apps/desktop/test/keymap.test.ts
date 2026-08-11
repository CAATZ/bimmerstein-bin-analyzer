import { describe, expect, it } from 'vitest';
import { resolveKey, type KeyInput } from '../src/lib/keymap.js';

function key(partial: Partial<KeyInput> & { key: string }): KeyInput {
  return { ctrl: false, shift: false, alt: false, meta: false, inEditable: false, ...partial };
}

describe('resolveKey — the frozen v1 map (spec §7)', () => {
  it.each([
    ['m', 'columns-inc'],
    ['M', 'columns-inc'],
    ['w', 'columns-dec'],
    ['W', 'columns-dec'],
    ['k', 'confirm-selection'],
    ['t', 'view-next'],
    ['p', 'toggle-preview'],
  ] as const)('%s → %s', (k, action) => {
    expect(resolveKey(key({ key: k }))).toBe(action);
  });

  it('F cycles potentials; Shift+F goes backwards', () => {
    expect(resolveKey(key({ key: 'f' }))).toBe('next-potential');
    expect(resolveKey(key({ key: 'F', shift: true }))).toBe('prev-potential');
  });

  it('Shift+T cycles views backwards', () => {
    expect(resolveKey(key({ key: 'T', shift: true }))).toBe('view-prev');
  });

  it('Ctrl+arrows shift the origin; plain arrows are unbound', () => {
    expect(resolveKey(key({ key: 'ArrowLeft', ctrl: true }))).toBe('origin-left');
    expect(resolveKey(key({ key: 'ArrowRight', ctrl: true }))).toBe('origin-right');
    expect(resolveKey(key({ key: 'ArrowLeft' }))).toBeUndefined();
    expect(resolveKey(key({ key: 'ArrowRight' }))).toBeUndefined();
  });

  it('Ctrl+B optimizes the value range; plain b is unbound', () => {
    expect(resolveKey(key({ key: 'b', ctrl: true }))).toBe('optimize-range');
    expect(resolveKey(key({ key: 'B', ctrl: true, shift: true }))).toBe('optimize-range');
    expect(resolveKey(key({ key: 'b' }))).toBeUndefined();
  });

  it('binds the keys v1 reserved for v2', () => {
    const base = { ctrl: false, shift: false, alt: false, meta: false, inEditable: false };
    expect(resolveKey({ ...base, key: '+' })).toBe('value-inc');
    expect(resolveKey({ ...base, key: '-' })).toBe('value-dec');
    expect(resolveKey({ ...base, key: 'F11' })).toBe('toggle-original');
  });

  it('still ignores them while typing in a field', () => {
    const base = { ctrl: false, shift: false, alt: false, meta: false, inEditable: true };
    expect(resolveKey({ ...base, key: '+' })).toBeUndefined();
    expect(resolveKey({ ...base, key: '-' })).toBeUndefined();
    expect(resolveKey({ ...base, key: 'F11' })).toBeUndefined();
  });

  it('suppressed while typing in an editable control', () => {
    expect(resolveKey(key({ key: 'm', inEditable: true }))).toBeUndefined();
    expect(resolveKey(key({ key: 'b', ctrl: true, inEditable: true }))).toBeUndefined();
  });

  it('Alt/Meta chords never match (OS shortcuts stay OS shortcuts)', () => {
    expect(resolveKey(key({ key: 'm', alt: true }))).toBeUndefined();
    expect(resolveKey(key({ key: 'm', meta: true }))).toBeUndefined();
  });

  it('Ctrl+letter chords other than B are unbound', () => {
    expect(resolveKey(key({ key: 'm', ctrl: true }))).toBeUndefined();
    expect(resolveKey(key({ key: 'k', ctrl: true }))).toBeUndefined();
  });
});

describe('undo bindings (spec §7, added 2026-08-01)', () => {
  it('Ctrl+Z undoes, Ctrl+Shift+Z redoes', () => {
    expect(resolveKey(key({ key: 'z', ctrl: true }))).toBe('undo');
    expect(resolveKey(key({ key: 'Z', ctrl: true, shift: true }))).toBe('redo');
  });

  it('plain z stays unbound', () => {
    expect(resolveKey(key({ key: 'z' }))).toBeUndefined();
  });

  it('an editable target still swallows them', () => {
    expect(resolveKey(key({ key: 'z', ctrl: true, inEditable: true }))).toBeUndefined();
  });
});
