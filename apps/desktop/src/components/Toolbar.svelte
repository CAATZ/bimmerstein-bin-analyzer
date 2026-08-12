<!-- apps/desktop/src/components/Toolbar.svelte -->
<script lang="ts">
  import { bin, coPilotEnabled, maps, scanStatus, viewParams, type ViewMode } from '../store/stores.js';
  import * as actions from '../store/actions.js';
  import { tauriHost } from '../platform/tauri.js';
  import {
    exportFlow, importDef, openBinFlow, openProjectFlow, pickDefFlow, saveProjectFlow, type ExportKind,
  } from '../platform/flows.js';
  import { cancelScan, runScan } from '../worker/controller.js';
  import RomPickerDialog from './RomPickerDialog.svelte';
  import AxisLibraryDialog from './AxisLibraryDialog.svelte';

  let { onSaveBin }: { onSaveBin: (promptAlways: boolean) => void } = $props();

  const VIEW_MODES: ViewMode[] = ['hex', '2d', '3d', 'map'];
  let exportKind: ExportKind = $state('csv');
  let pendingDef: { xml: string; romIds: string[] } | null = $state(null);
  let axisLibOpen = $state(false);

  async function onOpenBin(): Promise<void> {
    if (await openBinFlow(tauriHost)) runScan(); // locked decision 5: auto-scan on open
  }

  async function onImportDef(): Promise<void> {
    const picked = await pickDefFlow(tauriHost);
    if (picked === null) return;
    if (picked.romIds.length > 1) pendingDef = picked; // rom picker dialog
    else await importDef(tauriHost, picked.xml, picked.romIds[0]);
  }
</script>

<header class="toolbar">
  <button onclick={() => void onOpenBin()}>Open Bin</button>
  <button onclick={() => void onImportDef()} disabled={$bin === null}>Import Def</button>
  <button onclick={() => void openProjectFlow(tauriHost)}>Open Project</button>
  <button onclick={() => void saveProjectFlow(tauriHost)} disabled={$bin === null}>Save Project</button>
  <button onclick={() => onSaveBin(false)} disabled={$bin === null}>Save Bin</button>
  <button onclick={() => onSaveBin(true)} disabled={$bin === null}>Save Bin As…</button>
  <button onclick={() => (axisLibOpen = true)} disabled={$bin === null}>Axes</button>
  <label class="copilot-toggle" title="Let a connected agent see this session, point at things, and propose changes. Off by default.">
    <input type="checkbox" bind:checked={$coPilotEnabled} />
    Share session with co-pilot
  </label>
  <span class="sep"></span>
  {#if $scanStatus.state === 'running'}
    <button onclick={cancelScan}>Cancel scan</button>
  {:else}
    <button onclick={runScan} disabled={$bin === null}>Rescan</button>
  {/if}
  <span class="sep"></span>
  <label>width
    <select
      value={String($viewParams.format.width)}
      onchange={(e) => actions.setValueFormat({ width: Number(e.currentTarget.value) as 1 | 2 | 4 })}
    >
      <option value="1">1</option>
      <option value="2">2</option>
      <option value="4">4</option>
    </select>
  </label>
  <label>endian
    <select
      value={$viewParams.format.endianness}
      onchange={(e) => actions.setValueFormat({ endianness: e.currentTarget.value as 'little' | 'big' })}
    >
      <option value="little">LoHi (LE)</option>
      <option value="big">HiLo (BE)</option>
    </select>
  </label>
  <label>
    <input
      type="checkbox"
      checked={$viewParams.format.signed}
      onchange={(e) => actions.setValueFormat({ signed: e.currentTarget.checked })}
    />
    signed
  </label>
  <span class="sep"></span>
  {#each VIEW_MODES as mode (mode)}
    <button class:active={$viewParams.viewMode === mode} onclick={() => actions.setViewMode(mode)}>{mode}</button>
  {/each}
  <button class:active={$viewParams.previewOpen} onclick={actions.togglePreview}>preview</button>
  <span class="sep"></span>
  <select bind:value={exportKind}>
    <option value="csv">CSV</option>
    <option value="json">JSON</option>
    <option value="romraider">RomRaider XML</option>
    <option value="xdf">TunerPro XDF</option>
  </select>
  <button onclick={() => void exportFlow(tauriHost, exportKind)} disabled={$maps.length === 0}>Export</button>
</header>

{#if pendingDef !== null}
  <RomPickerDialog
    romIds={pendingDef.romIds}
    onpick={(romId) => {
      void importDef(tauriHost, pendingDef!.xml, romId);
      pendingDef = null;
    }}
    oncancel={() => {
      pendingDef = null;
    }}
  />
{/if}

{#if axisLibOpen}
  <AxisLibraryDialog onclose={() => (axisLibOpen = false)} />
{/if}

<style>
  .copilot-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 8px;
    white-space: nowrap;
    color: var(--fg-dim);
  }
</style>
