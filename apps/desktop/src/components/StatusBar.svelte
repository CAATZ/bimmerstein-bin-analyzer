<!-- apps/desktop/src/components/StatusBar.svelte -->
<script lang="ts">
  import { bin, coPilotStatus, scanStatus, selection, viewParams } from '../store/stores.js';
</script>

<footer class="status">
  {#if $bin}
    <span>{$bin.name} · {$bin.size.toLocaleString()} B · sha {$bin.sha256.slice(0, 12)}…</span>
  {:else}
    <span>no bin loaded</span>
  {/if}
  {#if $selection}
    <span>
      sel 0x{$selection.start.toString(16).toUpperCase()}–0x{$selection.end.toString(16).toUpperCase()}
      ({$selection.end - $selection.start} B{#if $selection.cols !== undefined}, {$selection.cols} cols{/if})
    </span>
  {/if}
  {#if $coPilotStatus !== 'off'}
    <span class="chip chip-{$coPilotStatus}">
      {#if $coPilotStatus === 'waiting'}Co-pilot: waiting…
      {:else if $coPilotStatus === 'connected'}Co-pilot: connected
      {:else}Co-pilot: disconnected — retrying
      {/if}
    </span>
  {/if}
  <span class="grow"></span>
  {#if $scanStatus.state === 'running'}
    <span>scanning: {$scanStatus.stage}</span>
    <progress max="1" value={$scanStatus.fraction}></progress>
  {:else if $scanStatus.state === 'error'}
    <span class="err">scan failed: {$scanStatus.message} — views work without detection</span>
  {:else if $scanStatus.state === 'canceled'}
    <span>scan canceled</span>
  {:else if $scanStatus.state === 'done'}
    <span>scan done</span>
  {/if}
  <span>
    cols {$viewParams.columns} · origin {$viewParams.origin} ·
    {$viewParams.format.width * 8}-bit {$viewParams.format.signed ? 'signed' : 'unsigned'}
    {$viewParams.format.width > 1 ? ($viewParams.format.endianness === 'little' ? 'LoHi' : 'HiLo') : ''}
  </span>
</footer>
