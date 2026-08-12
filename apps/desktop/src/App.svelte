<!-- apps/desktop/src/App.svelte -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import Toolbar from './components/Toolbar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import ChecksumDialog from './components/ChecksumDialog.svelte';
  import SaveReportDialog from './components/SaveReportDialog.svelte';
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
  import type { MapDef } from '@binanalyzer/core';
  import { bin, cellRange, lastSave, maps, modalOpen, potentialMaps, selection, showOriginal, viewParams } from './store/stores.js';
  import { tauriHost } from './platform/tauri.js';
  import { confirmCloseFlow, loadBinFromPath, saveBinFlow, saveProjectFlow } from './platform/flows.js';
  import { isModalOutcome } from './lib/savereport.js';
  import { runScan } from './worker/controller.js';
  import ProposalPanel from './components/ProposalPanel.svelte';
  import { CoPilotClient, type SocketLike } from './copilot/client.js';
  import { detectOsKind, linkFilePathFor, makeReadLink, type OsPaths } from './copilot/link-file.js';
  import { mountCoPilot, type CoPilotMount } from './copilot/mount.js';
  import { persistCoPilotConsent } from './store/consent.js';
  import { homeDir, localDataDir } from '@tauri-apps/api/path';

  let showChecksums = $state(false);
  let showSaveReport = $state(false);

  /** Both toolbar save commands. The report opens modally for anything that is
   *  not a clean correction, and for any failure (spec 2026-08-11 §6) — a
   *  failed write must not vanish with an auto-dismissing toast. */
  async function onSaveBin(promptAlways: boolean): Promise<void> {
    await saveBinFlow(tauriHost, { promptAlways });
    const o = get(lastSave);
    if (o !== null && isModalOutcome(o)) showSaveReport = true;
  }

  function isEditable(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    );
  }

  /** '+'/'-' (spec 2026-08-09-map-value-editing; amended 2026-08-09 for ranges,
   *  amended again by the I1 whole-branch-review fix): step the cells in the
   *  current range selection by one raw LSB, as one undo entry. No range
   *  means no target — a stray keypress must never rewrite the whole map, so
   *  the user is told to select a range first instead. */
  function stepSelectedMapValues(steps: 1 | -1): void {
    const sel = $selection;
    if (sel?.mapId === undefined) return;
    const m: MapDef | undefined = [...$maps, ...$potentialMaps].find((x) => x.id === sel.mapId);
    if (m === undefined) return;
    const cells = actions.cellsForDelta(m, $cellRange);
    if (cells.length === 0) {
      actions.pushToast('info', "'+'/'-' steps the current cell range — select a range first");
      return;
    }
    const { moved, clamped } = actions.applyRegionDelta(m, cells, { kind: 'step', steps });
    actions.pushToast('info', `${moved} cells changed${clamped > 0 ? `, ${clamped} clamped` : ''}`);
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
      case 'undo': actions.undo(); break;
      case 'redo': actions.redo(); break;
      case 'value-inc': stepSelectedMapValues(1); break;
      case 'value-dec': stepSelectedMapValues(-1); break;
      case 'toggle-original': showOriginal.update((v) => !v); break;
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
    // Closing the window discards unsaved byte edits, so it is guarded like every
    // other path that would (2026-08-11 spec §8 + its close-protection amendment).
    // Registering this handler is ALSO what closes the app — Tauri destroys the
    // window from here when the handler does not prevent the default — hence
    // `core:window:allow-destroy` in capabilities/default.json.
    const closeGuard = tauriHost.onCloseRequested(() => confirmCloseFlow(tauriHost));
    return () => {
      void subscription.then((unlisten) => unlisten());
      void closeGuard.then((unlisten) => unlisten());
    };
  });
  let coPilot: CoPilotMount | null = null;
  let stopConsentPersistence: (() => void) | null = null;

  onMount(() => {
    // Resolve the OS paths ONCE; the handshake location never moves at runtime.
    let linkPath = '';
    void (async () => {
      const paths: OsPaths = { home: await homeDir(), localAppData: await localDataDir() };
      linkPath = linkFilePathFor(detectOsKind(navigator.userAgent), paths);
    })();

    // Hydrate consent BEFORE mounting: mountCoPilot's subscription fires with
    // the current value, so a user who left the toggle on last session gets
    // their link back without re-ticking it (spec §4.5).
    stopConsentPersistence = persistCoPilotConsent(localStorage);

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

  onDestroy(() => {
    coPilot?.stop();
    stopConsentPersistence?.();
  });
</script>

<svelte:window onkeydown={onKeydown} />

<ProposalPanel onDecide={(id, ids) => coPilot?.current()?.decideProposal(id, ids)} />

<div class="app">
  <Toolbar onSaveBin={(prompt: boolean) => void onSaveBin(prompt)} />
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
  <StatusBar
    onShowChecksums={() => (showChecksums = true)}
    onShowSaveReport={() => (showSaveReport = true)}
  />
  <Toasts />
  {#if $viewParams.previewOpen}
    <PreviewPanel />
  {/if}
  {#if showChecksums}
    <ChecksumDialog onClose={() => (showChecksums = false)} />
  {/if}
  {#if showSaveReport}
    <SaveReportDialog onClose={() => (showSaveReport = false)} />
  {/if}
</div>
