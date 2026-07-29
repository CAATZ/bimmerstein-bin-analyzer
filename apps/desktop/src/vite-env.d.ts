/// <reference types="svelte" />
/// <reference types="vite/client" />

// Svelte 5.56 ships its `*.svelte` ambient module declaration only in its
// bundled legacy types (svelte/types/index.d.ts), which `moduleResolution:
// "bundler"` does not reach via `/// <reference types="svelte" />`. So `.ts`
// files importing `.svelte` (only main.ts -> App.svelte in this app) need it
// declared here. This mirrors svelte's own declaration verbatim; `.svelte` ->
// `.svelte` imports are still resolved natively by svelte-check with full
// prop typing and are unaffected by this fallback.
declare module '*.svelte' {
  // prettier-ignore
  import { SvelteComponent } from 'svelte'
  import { LegacyComponentType } from 'svelte/legacy';
  const Comp: LegacyComponentType;
  type Comp = SvelteComponent;
  export default Comp;
}
