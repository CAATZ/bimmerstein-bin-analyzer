<!-- apps/desktop/src/App.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Toolbar from './components/Toolbar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import Toasts from './components/Toasts.svelte';
  import HexdumpView from './views/HexdumpView.svelte';
  import View2d from './views/View2d.svelte';
  import MapView from './views/MapView.svelte';
  import View3d from './views/View3d.svelte';
  import CurveView from './views/CurveView.svelte';
  import SwitchView from './views/SwitchView.svelte';
  import PreviewPanel from './views/PreviewPanel.svelte';
  import { resolveKey } from './lib/keymap.js';
  import { isCurveShaped } from './lib/curvedata.js';
  import { isSwitch } from './lib/switchdata.js';
  import * as actions from './store/actions.js';
  import { bin, maps, modalOpen, potentialMaps, selection, viewParams } from './store/stores.js';
  import { tauriHost } from './platform/tauri.js';
  import { loadBinFromPath } from './platform/flows.js';
  import { runScan } from './worker/controller.js';

  function isEditable(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    );
  }

  function onKeydown(e: KeyboardEvent): void {
    if ($modalOpen) return; // a modal dialog is open — it owns input, not the global keymap
    const action = resolveKey({
      key: e.key,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey,
      inEditable: isEditable(e.target),
    });
    if (action === undefined) return;
    e.preventDefault();
    switch (action) {
      case 'columns-inc': actions.adjustColumns(1); break;
      case 'columns-dec': actions.adjustColumns(-1); break;
      case 'origin-left': actions.shiftOrigin(-1); break;
      case 'origin-right': actions.shiftOrigin(1); break;
      case 'confirm-selection': actions.confirmSelection(); break;
      case 'optimize-range': actions.optimizeValueRange(); break;
      case 'next-potential': actions.stepPotential(1); break;
      case 'prev-potential': actions.stepPotential(-1); break;
      case 'view-next': actions.cycleViewMode(1); break;
      case 'view-prev': actions.cycleViewMode(-1); break;
      case 'toggle-preview': actions.togglePreview(); break;
    }
  }

  const selectedIsCurve = $derived.by((): boolean => {
    const sel = $selection;
    if (!sel || sel.mapId === undefined) return false;
    const m = [...$maps, ...$potentialMaps].find((x) => x.id === sel.mapId);
    return m !== undefined && isCurveShaped(m);
  });

  const selectedIsSwitch = $derived.by((): boolean => {
    const sel = $selection;
    if (!sel || sel.mapId === undefined) return false;
    const m = [...$maps, ...$potentialMaps].find((x) => x.id === sel.mapId);
    return m !== undefined && isSwitch(m);
  });

  onMount(() => {
    const subscription = tauriHost.onFileDrop((paths) => {
      const first = paths[0];
      if (first === undefined) return;
      void loadBinFromPath(tauriHost, first).then((ok) => {
        if (ok) runScan();
      });
    });
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <Toolbar />
  <div class="body">
    <Sidebar />
    <main class="view">
      {#if $bin === null}
        <div class="empty">Open a bin (toolbar) or drop one on the window to begin.</div>
      {:else if $viewParams.viewMode === 'hex'}
        <HexdumpView />
      {:else if $viewParams.viewMode === '2d'}
        <View2d />
      {:else if $viewParams.viewMode === '3d'}
        <View3d />
      {:else if selectedIsSwitch}
        <SwitchView />
      {:else if selectedIsCurve}
        <CurveView />
      {:else}
        <MapView />
      {/if}
    </main>
  </div>
  <StatusBar />
  <Toasts />
  {#if $viewParams.previewOpen}
    <PreviewPanel />
  {/if}
</div>
