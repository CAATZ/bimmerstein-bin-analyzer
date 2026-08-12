<!-- apps/desktop/src/components/StatusBar.svelte -->
<script lang="ts">
  import { bin, checksumReport, coPilotStatus, editJournal, lastSave, scanStatus, selection, viewParams } from '../store/stores.js';

  let {
    onShowChecksums,
    onShowSaveReport,
  }: { onShowChecksums: () => void; onShowSaveReport: () => void } = $props();
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
  {#if $editJournal.size > 0}
    <span class="chip">{$editJournal.size} bytes changed</span>
  {/if}
  {#if $lastSave}
    <!-- Counts against the file as OPENED, unlike the chip above; the report
         says whether the buffer still matches what was written. -->
    <button class="chip chip-{$lastSave.ok ? 'connected' : 'disconnected'}" onclick={onShowSaveReport}>
      {$lastSave.ok ? `saved: ${$lastSave.name}` : 'last save FAILED'}
    </button>
  {/if}
  {#if $checksumReport}
    <button
      class="chip chip-{$checksumReport.valid ? 'connected' : 'disconnected'}"
      onclick={onShowChecksums}
    >
      <!-- `valid` covers only the checksums the family module stands behind —
           on MS41 the program checksum is always skipped. A bare "OK" would
           read as "everything checked out", so the count of not-checked blocks
           rides along; the dialog names them and says why.
           `applies === false` (I4): an edit broke the family's structural
           activation gate — `blocks` is empty, so falling through to the
           mismatch-count branch would misleadingly read "0 mismatched" on a
           modified image the module no longer recognises at all. -->
      Checksums: {!$checksumReport.applies
        ? 'structure changed — not recognised'
        : $checksumReport.valid
          ? 'OK'
          : `${$checksumReport.blocks.filter((b) => !b.ok).length} mismatched`}{$checksumReport.skipped
        .length > 0
        ? ` · ${$checksumReport.skipped.length} not checked`
        : ''}
    </button>
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
