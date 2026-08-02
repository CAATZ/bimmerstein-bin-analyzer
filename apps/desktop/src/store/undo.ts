import { derived, writable, type Readable } from 'svelte/store';
import { captureSession, restoreSession, type SessionSnapshot } from './session-snapshot.js';

/**
 * Bounded undo/redo over whole-session snapshots
 * (2026-08-01-mcp-copilot-design.md §6.2).
 *
 * One stack serves the user's own actions AND the co-pilot's — two divergent
 * stacks in one app is a bug generator. Snapshots share structure, so the real
 * memory cost is the single BinImage every entry references.
 *
 * This module must never import actions.ts: actions.ts calls into here.
 */
export const UNDO_LIMIT = 50;

interface Entry {
  label: string;
  snapshot: SessionSnapshot;
}

const past: Entry[] = [];
const future: Entry[] = [];
/** Bumped on every mutation so `undoState` recomputes. */
const revision = writable(0);
let txDepth = 0;

const touched = (): void => revision.update((n) => n + 1);

/**
 * Snapshot the session BEFORE a mutation. Callers must invoke this after their
 * validation guards and immediately before their first store write, so a
 * rejected action never lands a no-op entry.
 *
 * A no-op inside an open transaction: the outer call already snapshotted the
 * state this whole action started from.
 */
export function pushUndo(label: string): void {
  if (txDepth > 0) return;
  past.push({ label, snapshot: captureSession() });
  if (past.length > UNDO_LIMIT) past.shift();
  future.length = 0; // a new action abandons the redo branch
  touched();
}

/** Collapse an action that mutates repeatedly into ONE undo entry. */
export function undoTransaction<T>(label: string, fn: () => T): T {
  if (txDepth > 0) return fn();
  pushUndo(label);
  txDepth++;
  try {
    return fn();
  } finally {
    txDepth--;
  }
}

export function undo(): boolean {
  const entry = past.pop();
  if (entry === undefined) return false;
  future.push({ label: entry.label, snapshot: captureSession() });
  restoreSession(entry.snapshot);
  touched();
  return true;
}

export function redo(): boolean {
  const entry = future.pop();
  if (entry === undefined) return false;
  past.push({ label: entry.label, snapshot: captureSession() });
  restoreSession(entry.snapshot);
  touched();
  return true;
}

/** A new bin is a new address space — undoing across bins is meaningless. */
export function clearUndo(): void {
  past.length = 0;
  future.length = 0;
  txDepth = 0;
  touched();
}

export const undoState: Readable<{ canUndo: boolean; canRedo: boolean; nextUndoLabel: string | null }> =
  derived(revision, () => ({
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    nextUndoLabel: past.length > 0 ? past[past.length - 1]!.label : null,
  }));
