<!-- apps/desktop/src/components/SaveReportDialog.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { lastSave } from '../store/stores.js';
  import * as actions from '../store/actions.js';
  import { verdictHeadline } from '../lib/savereport.js';
  let { onClose }: { onClose: () => void } = $props();
  const hex = (v: number, w = 4): string => '0x' + v.toString(16).toUpperCase().padStart(w, '0');

  // Suspend the global keymap while this dialog is open.
  onMount(() => {
    actions.pushModal();
    return () => actions.popModal();
  });
</script>

<div class="backdrop">
  <div class="dialog" role="dialog" aria-label="Save report">
    <h2>Save</h2>
    {#if $lastSave === null}
      <p>Nothing has been saved in this session.</p>
    {:else if !$lastSave.ok}
      <p class="verdict bad">Not saved.</p>
      <p class="reason">{$lastSave.reason}</p>
      {#if $lastSave.path}<p class="mono">{$lastSave.path}</p>{/if}
    {:else}
      <p class="verdict {$lastSave.verdict.kind === 'corrected' ? 'ok' : 'bad'}">
        {verdictHeadline($lastSave.verdict)}
      </p>
      <p class="mono">
        {$lastSave.path} · {$lastSave.size.toLocaleString()} B · sha {$lastSave.sha256.slice(0, 16)}…
      </p>
      <p class="note">
        {$lastSave.editedBytes} byte(s) differ from the file as opened. The sha above was
        read back from the written file, not computed from what was sent.
      </p>
      <!-- Own scroll container: a flex child with overflow:visible defeats
           max-height and pushes the close button off-screen. -->
      <div class="rows">
        {#each $lastSave.corrected as c (c.offset)}
          <div class="row">
            <span class="name">corrected</span>
            <span>{hex(c.offset, 5)}</span>
            <span>{hex(c.from, 2)} → {hex(c.to, 2)}</span>
          </div>
        {/each}
        {#each $lastSave.report?.skipped ?? [] as s (s.id)}
          <div class="row skipped">
            <span class="name">{s.id}</span>
            <span class="reason">not corrected — {s.reason}</span>
          </div>
        {/each}
      </div>
      {#each $lastSave.report?.notes ?? [] as n}<p class="note">{n}</p>{/each}
    {/if}
    <div class="actions"><button onclick={onClose}>Close</button></div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: grid; place-items: center; }
  .dialog { display: flex; flex-direction: column; max-height: 80vh; min-width: 34rem;
            padding: 1rem; background: var(--bg, #1e1e1e); border-radius: 6px; }
  .rows { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .row { display: grid; grid-template-columns: 10rem 8rem 1fr; gap: .5rem;
         padding: .25rem 0; font-family: monospace; font-size: .85rem; }
  .row.skipped { grid-template-columns: 10rem 1fr; opacity: .7; }
  .verdict { font-weight: bold; }
  .verdict.ok { color: #6c6; }
  .verdict.bad { color: #f66; }
  .mono { font-family: monospace; font-size: .85rem; opacity: .85; }
  .note { font-size: .85rem; opacity: .85; }
  .actions { flex: 0 0 auto; display: flex; justify-content: flex-end; padding-top: .5rem; }
</style>
