// C2 regression test support only (test/reactivity-chain.test.ts).
//
// `svelte/internal/client` ships as plain JS with JSDoc types, and its
// package.json `exports` map for that subpath carries no `.d.ts` — svelte-check
// itself suggests exactly this fix ("try adding a new declaration (.d.ts) file
// containing `declare module 'svelte/internal/client'`"). Typed narrowly to the
// handful of runtime primitives the regression test actually drives, not `any`.
declare module 'svelte/internal/client' {
  /** Opaque handle for a derived signal — never constructed directly, only
   *  produced by `derived` and consumed by `get`. */
  interface DerivedSignal<T> {
    readonly __derivedBrand?: T;
  }

  export function derived<T>(fn: () => T): DerivedSignal<T>;
  export function get<T>(signal: DerivedSignal<T>): T;
  export function store_get<T>(
    store: { subscribe(run: (value: T) => void): () => void } | null | undefined,
    storeName: string,
    stores: Record<string, unknown>
  ): T;
  export function effect_root(fn: () => void | (() => void)): () => void;
  export function render_effect(fn: () => void | (() => void)): void;
  export function flush(fn?: () => void): void;
}
