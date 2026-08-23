import type { FamilyChecksums } from './types.js';

/**
 * Families registered at RUNTIME from a drop-in module
 * (2026-08-23-drop-in-family-modules-design.md).
 *
 * Module-level mutable state, deliberately: there is exactly one app process
 * and exactly one set of loaded modules, and threading a registry object
 * through every caller of `checksumsFor` would buy nothing.
 *
 * This package stays PURE — it never reads a file and never evaluates source.
 * The app reads the file, evaluates it, and hands over a plain object. A guard
 * test pins that (packages/families/test/purity.test.ts).
 */
const externals: FamilyChecksums[] = [];

export function registerExternalFamily(mod: FamilyChecksums): void {
  externals.push(mod);
}

export function clearExternalFamilies(): void {
  externals.length = 0;
}

/** Frozen: a caller that mutated this would silently change what the app trusts. */
export function externalFamilies(): readonly FamilyChecksums[] {
  return Object.freeze([...externals]);
}
