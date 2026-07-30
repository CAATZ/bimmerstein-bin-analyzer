<!-- apps/desktop/src/components/AxisPickerDialog.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { AxisLibEntry } from '@binanalyzer/core';
  import * as actions from '../store/actions.js';

  interface Props {
    /** Pre-filtered by the caller (dimension fit for the target slot). */
    entries: AxisLibEntry[];
    onpick: (entry: AxisLibEntry) => void;
    oncancel: () => void;
  }
  const { entries, onpick, oncancel }: Props = $props();
  let chosenId = $state('');

  // Suspend the global keymap (T/K etc.) while this dialog is open.
  onMount(() => {
    actions.pushModal();
    return () => actions.popModal();
  });

  function fmt(e: AxisLibEntry): string {
    const a = e.axis;
    const where = a.kind === 'referenced' && a.address !== undefined ? `0x${a.address.toString(16).toUpperCase()}` : 'literal';
    return `${e.name} — ${where} ×${a.count}`;
  }
</script>

<div class="overlay" role="dialog" aria-label="Pick axis from library">
  <div class="dialog">
    <h3>Pick axis from library</h3>
    {#if entries.length === 0}
      <p class="empty">No library entries fit this slot's cell count.</p>
    {:else}
      <select size="10" bind:value={chosenId}>
        {#each entries as e (e.id)}
          <option value={e.id}>{fmt(e)}</option>
        {/each}
      </select>
    {/if}
    <div class="row">
      <button onclick={oncancel}>Cancel</button>
      <button disabled={chosenId === ''} onclick={() => onpick(entries.find((e) => e.id === chosenId)!)}>Attach</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 55%);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
  }
  .dialog {
    background: var(--bg-panel);
    border: 1px solid #3a3f48;
    border-radius: 8px;
    padding: 16px;
    width: 340px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  select {
    width: 100%;
  }
  .empty {
    color: var(--fg-dim);
    margin: 0;
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
