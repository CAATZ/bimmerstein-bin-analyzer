<!-- apps/desktop/src/components/FamiliesDialog.svelte -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { popModal, pushModal } from '../store/actions.js';
  import { configuredFamilyPaths, loadedFamilies } from '../store/families.js';
  import {
    addFamilyModule,
    builtInFamilies,
    familiesFolder,
    reloadFamilies,
    removeFamilyModule,
  } from '../platform/familyflows.js';
  import { tauriHost } from '../platform/tauri.js';

  let { appLocalData, onclose }: { appLocalData: string; onclose: () => void } = $props();

  onMount(() => pushModal());
  onDestroy(() => popModal());

  const rows = $derived([...builtInFamilies(), ...$loadedFamilies]);
</script>

<div class="backdrop">
  <div class="panel" role="dialog" aria-modal="true" aria-label="Families">
    <h2>Families</h2>
    <p class="reason">
      Drop a <code>.js</code> module into {familiesFolder(appLocalData)} — or add one below.
    </p>

    <ul class="rows">
      {#each rows as f (f.path + f.familyId)}
        <li>
          <span class="name">{f.familyId}</span>
          <span class="dim">{f.path}</span>
          {#if $configuredFamilyPaths.includes(f.path)}
            <button class="link" onclick={() => void removeFamilyModule(tauriHost, appLocalData, f.path)}>
              remove
            </button>
          {/if}
        </li>
      {/each}
    </ul>

    <div class="actions">
      <button onclick={() => void reloadFamilies(tauriHost, appLocalData)}>Reload</button>
      <button onclick={() => void addFamilyModule(tauriHost, appLocalData)}>Add module…</button>
      <button class="primary" onclick={onclose}>Close</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 45%);
    z-index: 40;
  }
  .panel {
    display: flex;
    flex-direction: column;
    max-height: 80vh;
    max-width: min(44rem, 92vw);
    min-width: min(30rem, 90vw);
    padding: 1rem;
    gap: 0.5rem;
    background: var(--bg-panel);
    color: var(--fg);
    border: 1px solid var(--bg-raise);
    border-radius: 6px;
  }
  h2 { margin: 0; font-size: 1.05rem; }
  .reason { margin: 0; color: var(--fg-dim); font-size: 0.9em; word-break: break-all; }
  /* Scrolls in ITS OWN container — the Axis Library failure mode, twice seen. */
  .rows {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    margin: 0;
    padding: 0.25rem 0;
    list-style: none;
    border-top: 1px solid var(--bg-raise);
    border-bottom: 1px solid var(--bg-raise);
  }
  .rows li {
    display: grid;
    grid-template-columns: 8rem 1fr auto;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.15rem 0;
  }
  .dim { color: var(--fg-dim); font-size: 0.85em; word-break: break-all; }
  .link {
    background: none;
    border: none;
    color: var(--fg-dim);
    text-decoration: underline;
    cursor: pointer;
    padding: 0;
  }
  .actions { display: flex; gap: 0.5rem; justify-content: flex-end; flex: 0 0 auto; }
  .primary { font-weight: 600; }
</style>
