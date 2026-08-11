import { describe, expect, it } from 'vitest';
import { writable } from 'svelte/store';
import {
  derived as $derived,
  effect_root,
  flush,
  get as $get,
  render_effect,
  store_get,
} from 'svelte/internal/client';
import type { EditJournal } from '@binanalyzer/core';
import { bytesForDisplay } from '../src/lib/diffcells.js';

/**
 * C2 (CRITICAL regression — "the map grid goes stale after every edit").
 *
 * `$workingBytes` is a Svelte store whose VALUE is a `Uint8Array` that
 * `applyEdit` mutates IN PLACE and then re-publishes with
 * `workingBytes.set(sameReference)` (packages/core/src/edits.ts +
 * apps/desktop/src/store/actions.ts `editCell`). Svelte 5's `$derived`
 * memoizes on `derived.equals`, which defaults to strict `===`. So a derived
 * that reads `$workingBytes` and hands the SAME reference straight back out
 * (the regressed shape MapView.svelte's `displayBytes` used to have) never
 * changes what it returns, its own write version never bumps, and nothing
 * downstream of it — `grid`, `xLabels`, `yLabels` — is ever told to
 * recompute. The view keeps showing pre-edit numbers.
 *
 * This file drives Svelte's own runtime primitives directly — `derived`,
 * `store_get`, `get`, `effect_root`, `render_effect`, `flush` from
 * `svelte/internal/client` — the exact functions the compiler emits for
 * `$derived.by(...)` and a `$store` read inside a component. That lets it
 * build the SAME dependency-graph shape MapView.svelte's `grid` uses,
 * mutate a buffer in place exactly like `applyEdit` does, and assert on
 * whether the chain actually recomputes — without a component, without the
 * Svelte compiler, and without touching a real `.svelte` file. No component
 * test harness exists in this repo (hence this file living in `test/`
 * alongside the rest of the plain-Vitest suite rather than a new tooling
 * dependency).
 */

interface Chain {
  workingBytes: ReturnType<typeof writable<Uint8Array | null>>;
  showOriginal: ReturnType<typeof writable<boolean>>;
  editJournal: ReturnType<typeof writable<EditJournal>>;
  buffer: Uint8Array;
}

function makeChain(): Chain {
  const buffer = Uint8Array.from([1, 2, 3, 4]);
  return {
    workingBytes: writable<Uint8Array | null>(buffer),
    showOriginal: writable<boolean>(false),
    editJournal: writable<EditJournal>(new Map()),
    buffer,
  };
}

/** Mutate the buffer in place, then re-publish the SAME reference — exactly
 *  what `applyEdit` + `workingBytes.set(working)` does on every cell edit. */
function editInPlace(chain: Chain, index: number, value: number): void {
  chain.buffer[index] = value;
  chain.workingBytes.set(chain.buffer);
}

describe('reactivity chain: a derived over a store whose buffer is mutated in place', () => {
  it('BROKEN shape — an intermediate derived that returns the store’s own buffer reference does NOT propagate a later in-place edit', () => {
    const chain = makeChain();
    const s = {}; // per-"component" StoreReferencesContainer, as the compiler allocates one per instance

    // Mirrors the REGRESSED `displayBytes`: reads the stores, hands `w` straight back out.
    const displayBytes = $derived(() => {
      const w = store_get(chain.workingBytes, '$workingBytes', s);
      if (w === null) return null;
      const showOrig = store_get(chain.showOriginal, '$showOriginal', s);
      const journal = store_get(chain.editJournal, '$editJournal', s);
      return showOrig ? bytesForDisplay(w, true, journal) : w; // same reference back out on the F11-off path
    });
    // Mirrors `grid`: only ever reads the intermediate derived, like `gridFromMap(displayBytes, m)` did.
    const firstByte = $derived(() => {
      const db = $get(displayBytes);
      return db === null ? null : db[0]!;
    });

    let observed: number | null = null;
    const dispose = effect_root(() => {
      render_effect(() => {
        observed = $get(firstByte);
      });
    });

    expect(observed).toBe(1);

    editInPlace(chain, 0, 99);
    flush();

    // THE HAZARD: the buffer now holds 99 at offset 0, but the view is still
    // showing 1 — `displayBytes` returned the same reference, so `derived.equals`
    // (===) said "unchanged" and `firstByte` was never asked to recompute.
    expect(observed).toBe(1);

    dispose();
  });

  it('FIXED shape — bytesForDisplay called directly inside the view-facing derived (no memoizing middle step) DOES propagate', () => {
    const chain = makeChain();
    const s = {};

    // Mirrors the FIXED `grid`/`xLabels`/`yLabels`: reads working/showOriginal/
    // journal itself and calls the plain `bytesForDisplay` helper — there is no
    // derived anywhere in the chain that could hand back the store's own
    // reference and get memoized away.
    const firstByte = $derived(() => {
      const w = store_get(chain.workingBytes, '$workingBytes', s);
      const showOrig = store_get(chain.showOriginal, '$showOriginal', s);
      const journal = store_get(chain.editJournal, '$editJournal', s); // read unconditionally, before any branch
      if (w === null) return null;
      return bytesForDisplay(w, showOrig, journal)[0]!;
    });

    let observed: number | null = null;
    const dispose = effect_root(() => {
      render_effect(() => {
        observed = $get(firstByte);
      });
    });

    expect(observed).toBe(1);

    editInPlace(chain, 0, 99);
    flush();

    // Fixed: the same in-place-mutated, same-reference re-publish IS observed —
    // `store_get`'s backing source uses `safe_equals`, which always propagates
    // for objects regardless of reference identity, and there is no downstream
    // derived that could memoize that propagation away.
    expect(observed).toBe(99);

    dispose();
  });

  it('FIXED shape also reacts to an edit journal change alone (F11 on), proving the unconditional journal read is a live dependency, not dead code', () => {
    const chain = makeChain();
    const s = {};
    chain.showOriginal.set(true);

    const firstByte = $derived(() => {
      const w = store_get(chain.workingBytes, '$workingBytes', s);
      const showOrig = store_get(chain.showOriginal, '$showOriginal', s);
      const journal = store_get(chain.editJournal, '$editJournal', s);
      if (w === null) return null;
      return bytesForDisplay(w, showOrig, journal)[0]!;
    });

    let observed: number | null = null;
    const dispose = effect_root(() => {
      render_effect(() => {
        observed = $get(firstByte);
      });
    });

    expect(observed).toBe(1); // F11 on, no edits yet: original == working

    // Simulate what editCell does: mutate working in place, journal the original,
    // then publish BOTH stores — exactly as `editCell` calls
    // `workingBytes.set(working); editJournal.set(journal);`.
    chain.buffer[0] = 99;
    const journal: EditJournal = new Map([[0, { original: 1, current: 99 }]]);
    chain.workingBytes.set(chain.buffer);
    chain.editJournal.set(journal);
    flush();

    // F11 is still on: bytesForDisplay reconstructs the ORIGINAL value (1) from
    // working + journal, so the displayed byte must NOT track the edit.
    expect(observed).toBe(1);

    dispose();
  });
});
