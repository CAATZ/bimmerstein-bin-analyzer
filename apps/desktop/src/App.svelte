<!-- apps/desktop/src/App.svelte -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
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
  import { redo, undo } from './store/undo.js';
  import { isCurveShaped } from './lib/curvedata.js';
  import { isSwitch } from './lib/switchdata.js';
  import * as actions from './store/actions.js';
  import { bin, maps, modalOpen, potentialMaps, selection, viewParams } from './store/stores.js';
  import { tauriHost } from './platform/tauri.js';
  import { loadBinFromPath, saveProjectFlow } from './platform/flows.js';
  import { runScan } from './worker/controller.js';
  import ProposalPanel from './components/ProposalPanel.svelte';
  import { CoPilotClient, type SocketLike } from './copilot/client.js';
  import { detectOsKind, linkFilePathFor, makeReadLink, type OsPaths } from './copilot/link-file.js';
  import { mountCoPilot, type CoPilotMount } from './copilot/mount.js';
  import { homeDir, localDataDir } from '@tauri-apps/api/path';

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
      case 'undo': undo(); break;
      case 'redo': redo(); break;
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
  let coPilot: CoPilotMount | null = null;

  onMount(() => {
    // Resolve the OS paths ONCE; the handshake location never moves at runtime.
    let linkPath = '';
    void (async () => {
      const paths: OsPaths = { home: await homeDir(), localAppData: await localDataDir() };
      linkPath = linkFilePathFor(detectOsKind(navigator.userAgent), paths);
    })();

    coPilot = mountCoPilot(
      () =>
        new CoPilotClient({
          connect: (url) => new WebSocket(url) as unknown as SocketLike,
          readLink: makeReadLink(tauriHost, () => linkPath),
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
          saveProject: () => saveProjectFlow(tauriHost),
        })
    );
  });

  onDestroy(() => coPilot?.stop());
</script>

<svelte:window onkeydown={onKeydown} />

<ProposalPanel onDecide={(id, ids) => coPilot?.current()?.decideProposal(id, ids)} />

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
