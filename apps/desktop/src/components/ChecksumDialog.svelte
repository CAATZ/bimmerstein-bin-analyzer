<!-- apps/desktop/src/components/ChecksumDialog.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { checksumReport } from '../store/stores.js';
  import * as actions from '../store/actions.js';
  let { onClose }: { onClose: () => void } = $props();
  const hex = (v: number, w = 4): string => '0x' + v.toString(16).toUpperCase().padStart(w, '0');

  // Suspend the global keymap (T/K etc.) while this dialog is open.
  onMount(() => {
    actions.pushModal();
    return () => actions.popModal();
  });
</script>

<div class="backdrop">
  <div class="dialog" role="dialog" aria-label="Checksums">
    <h2>Checksums</h2>
    {#if $checksumReport}
      <!-- Own scroll container: a flex child with overflow:visible defeats
           max-height and pushes the close button off-screen. That regression
           has hit this codebase twice — do not remove. -->
      <div class="rows">
        {#each $checksumReport.blocks as b (b.id)}
          <div class="row {b.ok ? 'ok' : 'bad'}">
            <span class="name">{b.label}</span>
            {#each b.covers as c}<span>{hex(c.start, 5)}–{hex(c.end, 5)}</span>{/each}
            <span>stored {hex(b.stored)} / computed {hex(b.computed)}</span>
            <span class="verdict">{b.ok ? 'OK' : 'MISMATCH'}</span>
          </div>
        {/each}
        {#each $checksumReport.skipped as s (s.id)}
          <div class="row skipped">
            <span class="name">{s.id}</span>
            <span class="reason">not checked — {s.reason}</span>
          </div>
        {/each}
      </div>
      {#each $checksumReport.notes as n}<p class="note">{n}</p>{/each}
    {:else}
      <p>No checksum information for this bin.</p>
    {/if}
    <div class="actions"><button onclick={onClose}>Close</button></div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: grid; place-items: center; }
  .dialog { display: flex; flex-direction: column; max-height: 80vh; min-width: 34rem;
            padding: 1rem; background: var(--bg, #1e1e1e); border-radius: 6px; }
  .rows { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .row { display: grid; grid-template-columns: 10rem 12rem 1fr auto; gap: .5rem;
         padding: .25rem 0; font-family: monospace; font-size: .85rem; }
  .row.bad .verdict { color: #f66; font-weight: bold; }
  .row.ok .verdict { color: #6c6; }
  .row.skipped { grid-template-columns: 10rem 1fr; opacity: .7; }
  .note { font-size: .85rem; opacity: .85; }
  .actions { flex: 0 0 auto; display: flex; justify-content: flex-end; padding-top: .5rem; }
</style>
