<!-- apps/desktop/src/components/RomPickerDialog.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import * as actions from '../store/actions.js';

  interface Props {
    romIds: string[];
    onpick: (romId: string) => void;
    oncancel: () => void;
  }
  const { romIds, onpick, oncancel }: Props = $props();
  let chosen = $state('');

  // Suspend the global keymap (T/K etc.) while this dialog is open.
  onMount(() => {
    actions.pushModal();
    return () => actions.popModal();
  });
</script>

<div class="overlay" role="dialog" aria-label="Choose rom">
  <div class="dialog">
    <h3>Multi-rom definition — choose the CAL ID</h3>
    <select size="10" bind:value={chosen}>
      {#each romIds as id (id)}
        <option value={id}>{id}</option>
      {/each}
    </select>
    <div class="row">
      <button onclick={oncancel}>Cancel</button>
      <button disabled={chosen === ''} onclick={() => onpick(chosen)}>Import</button>
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
    z-index: 50;
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
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
