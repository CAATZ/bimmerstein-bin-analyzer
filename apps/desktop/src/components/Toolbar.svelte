<!-- apps/desktop/src/components/Toolbar.svelte -->
<script lang="ts">
  import { bin, coPilotEnabled, editJournal, maps, potentialMaps, saveTarget, scanStatus, selection, showOriginal, transposeMaps, viewParams, workingBytes, type ViewMode } from '../store/stores.js';
  import { undoState } from '../store/undo.js';
  import logo from '../../src-tauri/icons/bimmerstein-blue.svg';
  import * as actions from '../store/actions.js';
  import { tauriHost } from '../platform/tauri.js';
  import {
    closeBinFlow, exportFlow, exportPackFlow, importDef, openBinFlow, openPackFlow, openProjectFlow, pickDefFlow,
    saveProjectFlow, type ExportKind,
  } from '../platform/flows.js';
  import { cancelScan, runScan } from '../worker/controller.js';
  import RomPickerDialog from './RomPickerDialog.svelte';
  import AxisLibraryDialog from './AxisLibraryDialog.svelte';
  import FamiliesDialog from './FamiliesDialog.svelte';
  import AboutDialog from './AboutDialog.svelte';
  import { openHelp } from '../platform/help.js';

  let {
    onSaveBin,
    appLocalData,
  }: { onSaveBin: (promptAlways: boolean) => void; appLocalData: string } = $props();

  const VIEW_MODES: { mode: ViewMode; label: string }[] = [
    { mode: 'hex', label: 'Hex' }, { mode: '2d', label: '2D' },
    { mode: 'map', label: 'Table' }, { mode: '3d', label: '3D' },
  ];
  let commands: HTMLElement;
  const dirty = $derived.by(() => {
    if (!$workingBytes || $editJournal.size === 0) return false;
    void $saveTarget;
    return actions.isDirty();
  });
  function closeMenus(event: Event): void {
    for (const menu of commands.querySelectorAll('details[open]')) {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        menu.querySelector('summary')?.focus();
      } else if (menu.contains(event.target as Node) && !(event.target as HTMLElement).closest('button')) continue;
      menu.removeAttribute('open');
    }
  }
  let exportKind: ExportKind = $state('csv');
  let pendingDef: { xml: string; romIds: string[] } | null = $state(null);
  let axisLibOpen = $state(false);
  let familiesOpen = $state(false);
  let aboutOpen = $state(false);
  const confirmed = $derived($selection?.mapId !== undefined && $maps.some((map) => map.id === $selection?.mapId));
  const selectedMap = $derived([...$maps, ...$potentialMaps].find((map) => map.id === $selection?.mapId));

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

<svelte:window onclick={closeMenus} onkeydown={closeMenus} />

<header class="workspace-header">
 <div class="command-row">
  <img class="brand" src={logo} alt="BimmerStein" />
  <nav bind:this={commands} aria-label="Application commands">
   <details>
    <summary>File</summary>
    <div class="command-menu">
  <button onclick={() => void closeBinFlow(tauriHost)} disabled={$bin === null}>Close Bin</button>
  <button onclick={() => void onImportDef()} disabled={$bin === null}>Import Definition…</button>
  <button onclick={() => void openProjectFlow(tauriHost)}>Open Project</button>
  <button title="Save map definitions, axes and project metadata" onclick={() => void saveProjectFlow(tauriHost)} disabled={$bin === null}>Save Project</button>
  <button onclick={() => onSaveBin(true)} disabled={$bin === null}>Save Bin As…</button>
  <hr />
  <label>Export format <select bind:value={exportKind}>
    <option value="csv">CSV</option><option value="json">JSON</option>
    <option value="romraider">RomRaider XML</option><option value="xdf">TunerPro XDF</option>
  </select></label>
  <button onclick={() => void exportFlow(tauriHost, exportKind)} disabled={$maps.length === 0}>Export</button>
  <button onclick={() => void exportPackFlow(tauriHost)} disabled={$bin === null}>Export Pack</button>
  <button onclick={() => void openPackFlow(tauriHost)} disabled={$bin === null}>Apply Pack</button>
    </div>
   </details>
   <details>
    <summary>Edit</summary>
    <div class="command-menu">
      <button disabled={!$undoState.canUndo} onclick={actions.undo}>Undo <kbd>Ctrl+Z</kbd></button>
      <button disabled={!$undoState.canRedo} onclick={actions.redo}>Redo <kbd>Ctrl+Y</kbd></button>
      <button disabled={!$selection} onclick={actions.confirmSelection}>Confirm selection <kbd>K</kbd></button>
      <button disabled={!$selection} onclick={actions.optimizeValueRange}>Optimize range <kbd>Ctrl+B</kbd></button>
      <button disabled={!$bin} aria-pressed={$showOriginal} onclick={() => showOriginal.update((v) => !v)}>Original values <kbd>F11</kbd></button>
    </div>
   </details>
   <details>
    <summary>Tools</summary>
    <div class="command-menu">
  <button onclick={() => (familiesOpen = true)}>Families…</button>
  <button onclick={() => (axisLibOpen = true)} disabled={$bin === null}>Axes</button>
  <label class="copilot-toggle" title="Let a connected agent see this session, point at things, and propose changes. Off by default.">
    <span>Share session with co-pilot</span>
    <input type="checkbox" bind:checked={$coPilotEnabled} />
  </label>
    </div>
   </details>
  </nav>
  <div class="help-commands" role="group" aria-label="Help">
    <button onclick={() => void openHelp('manual')}>User Manual</button>
    <button onclick={() => (aboutOpen = true)}>About</button>
  </div>
  <div class="file-identity" title={$bin ? `${$bin.name}\n${$bin.size.toLocaleString()} bytes\nSHA-256 ${$bin.sha256}` : 'BimmerStein Bin Analyzer'}>
    <strong>{$bin?.name ?? 'Bin Analyzer'}</strong>
    {#if $bin}<span class:unsaved={dirty}>{dirty ? 'Unsaved BIN changes' : $saveTarget ? 'BIN saved' : 'BIN unchanged'}</span>{/if}
  </div>
 </div>
 <div class="toolbar">
  <button class="primary" onclick={() => void onOpenBin()}>Open Bin</button>
  <button title="Write BIN values with checksum handling and read-back verification" onclick={() => onSaveBin(false)} disabled={$bin === null}>Save Bin</button>
  {#if $scanStatus.state === 'running'}
    <button onclick={cancelScan}>Cancel scan</button>
  {:else}
    <button onclick={runScan} disabled={$bin === null}>Rescan</button>
  {/if}
  <div class="view-switch" role="group" aria-label="View mode">
  {#each VIEW_MODES as { mode, label } (mode)}
    <button class:active={$viewParams.viewMode === mode} aria-pressed={$viewParams.viewMode === mode} onclick={() => actions.setViewMode(mode)}>{label}</button>
  {/each}
  </div>
  <button class:active={$viewParams.previewOpen} aria-pressed={$viewParams.previewOpen} onclick={actions.togglePreview}>Preview</button>
  {#if $viewParams.viewMode === 'hex' || $viewParams.viewMode === '2d'}
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
  {/if}
  {#if $viewParams.viewMode === 'map' || $viewParams.viewMode === '3d' || $viewParams.previewOpen}
  <button
    class:active={$transposeMaps}
    aria-pressed={$transposeMaps}
    disabled={!selectedMap || selectedMap.rows < 2 || selectedMap.cols < 2}
    title="Swap rows and columns in the table, 3D view and preview. Stored data stays unchanged."
    onclick={actions.toggleMapTranspose}
  >Swap X/Y</button>
  {/if}
  {#if $bin && $selection}
  <div class="selection-actions" role="group" aria-label="Selection confirmation">
    <span class="selection-summary" title="Selected file address and stored dimensions">
      0x{$selection.start.toString(16).toUpperCase()} · {selectedMap ? `${selectedMap.rows}×${selectedMap.cols}` : `${$selection.end - $selection.start} B`}
    </span>
    <button class="confirm-selection" class:confirmed disabled={confirmed}
      aria-label={confirmed ? 'Confirmed map' : 'Confirm selection'}
      title={confirmed ? 'This map is already in Maps' : 'Add this selection to Maps (K)'}
      onclick={actions.confirmSelection}>
      <span aria-hidden="true">✓</span> {confirmed ? 'Confirmed' : 'Confirm selection'}
      {#if !confirmed}<kbd aria-hidden="true">K</kbd>{/if}
    </button>
  </div>
  {/if}
 </div>
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
{#if familiesOpen}
  <FamiliesDialog {appLocalData} onclose={() => (familiesOpen = false)} />
{/if}
{#if aboutOpen}
  <AboutDialog onclose={() => (aboutOpen = false)} />
{/if}

<style>
  .workspace-header { flex: 0 0 auto; }
  .command-row { display: flex; align-items: center; gap: 14px; padding: 8px 16px 2px; background: var(--bg-panel); }
  .brand { width: 28px; height: 28px; }
  nav { display: flex; gap: 4px; }
  details { position: relative; }
  summary { list-style: none; cursor: pointer; padding: 6px 10px; border-radius: 5px; }
  summary:hover, details[open] summary { background: var(--bg-raise); }
  summary::-webkit-details-marker { display: none; }
  .command-menu { position: absolute; top: 100%; left: 0; z-index: 35; width: 270px; display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-panel); box-shadow: 0 12px 30px #0008; }
  .command-menu button { text-align: left; border-color: transparent; background: transparent; }
  .command-menu button:hover:not(:disabled) { background: var(--bg-raise); }
  .command-menu label { display: flex; flex-direction: column; gap: 6px; padding: 6px; color: var(--fg-dim); font-size: 12px; }
  .command-menu hr { border: 0; border-top: 1px solid var(--border); width: 100%; }
  kbd { float: right; font: inherit; color: var(--fg-dim); }
  .file-identity { margin-left: auto; display: flex; align-items: baseline; gap: 12px; min-width: 0; font-size: 12px; }
  .file-identity strong { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .file-identity span { color: var(--fg-dim); flex-shrink: 0; }
  .file-identity .unsaved { color: var(--warn); }
  .view-switch { display: flex; margin: 0 6px; padding: 3px; background: var(--bg); border: 1px solid var(--border); border-radius: 7px; }
  .view-switch button { min-width: 50px; background: transparent; border-color: transparent; }
  .view-switch button.active { background: #284369; border-color: #446895; }
  @media (max-width: 800px) { .file-identity { flex-direction: column; gap: 0; } }
  .command-menu label.copilot-toggle {
    display: inline-flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
    gap: 4px;
    margin: 0;
    color: var(--fg-dim);
  }
  .copilot-toggle input { flex-shrink: 0; margin: 0; }
  .help-commands { display: flex; gap: 4px; flex-shrink: 0; }
  .help-commands button { background: transparent; border-color: transparent; color: var(--fg-dim); padding: 6px 8px; font-size: 12px; }
  .help-commands button:hover { background: var(--bg-raise); color: var(--fg); }
  .selection-actions { display: flex; align-items: center; gap: 10px; margin-left: auto; font-size: 12px; }
  .selection-summary { color: var(--fg-dim); white-space: nowrap; }
  .confirm-selection { display: inline-flex; align-items: center; gap: 7px; background: #263952; border-color: #446895; font-size: 12px; }
  .confirm-selection kbd { font-size: 10px; border: 1px solid #52647c; border-radius: 3px; padding: 0 3px; }
  .confirm-selection.confirmed { opacity: 1; color: var(--fg-dim); background: transparent; border-color: transparent; }
  @media (max-width: 800px) { .command-row { gap: 6px; } }
</style>
