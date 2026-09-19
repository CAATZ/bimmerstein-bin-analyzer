<!-- apps/desktop/src/views/PreviewPanel.svelte -->
<script lang="ts">
  import { maps, potentialMaps, selection, transposeMaps, viewParams, workingBytes } from '../store/stores.js';
  import { surfaceFromMap, gridFromSelection, type SurfaceGrid } from '../lib/griddata.js';
  import { SurfaceRenderer } from './surface.js';
  import { DEFAULT_WORKSPACE, setWorkspace, workspace } from '../store/workspace.js';
  import { togglePreview } from '../store/actions.js';

  let panel: HTMLDivElement;
  let w = $state(0);
  let h = $state(0);
  let drag: { start: number; size: number } | null = null;
  const right = $derived($workspace.previewPosition === 'right');

  function resize(next: number): void {
    const available = right ? panel.parentElement!.clientWidth : panel.parentElement!.clientHeight;
    const size = Math.round(Math.max(right ? 240 : 180, Math.min(next, available * 0.55)));
    setWorkspace(right ? { previewWidth: size } : { previewHeight: size });
  }
  function resizeKey(e: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    resize(e.key === 'Home' ? (right ? DEFAULT_WORKSPACE.previewWidth : DEFAULT_WORKSPACE.previewHeight)
      : (right ? panel.clientWidth : panel.clientHeight) + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 20 : -20));
  }

  let canvas: HTMLCanvasElement;
  let overlay: HTMLDivElement;
  let renderer: SurfaceRenderer | null = null;

  const grid = $derived.by((): SurfaceGrid | null => {
    const wb = $workingBytes;
    const sel = $selection;
    if (!wb || !sel) return null;
    if (sel.mapId !== undefined) {
      const m = [...$maps, ...$potentialMaps].find((x) => x.id === sel.mapId);
      if (m) return surfaceFromMap(wb, m, $transposeMaps);
    }
    return gridFromSelection(wb, sel.start, sel.end, sel.cols ?? $viewParams.columns, $viewParams.format);
  });

  $effect(() => {
    renderer = new SurfaceRenderer(canvas, overlay, true);
    return () => {
      renderer?.dispose();
      renderer = null;
    };
  });
  $effect(() => {
    renderer?.resize(w, h, window.devicePixelRatio || 1);
  });
  $effect(() => {
    renderer?.setGrid(grid);
  });
</script>

<div class="preview-panel" class:right bind:this={panel}
  style:width={right ? `${$workspace.previewWidth}px` : '100%'}
  style:height={right ? '100%' : `${$workspace.previewHeight}px`}>
 <button class="preview-splitter" aria-label="Resize 3D preview" title="Drag to resize; arrow keys adjust size; Home resets" onkeydown={resizeKey}
  onpointerdown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); drag = { start: right ? e.clientX : e.clientY, size: right ? panel.clientWidth : panel.clientHeight }; e.currentTarget.setPointerCapture(e.pointerId); }}
  onpointermove={(e) => { if (drag) resize(drag.size + drag.start - (right ? e.clientX : e.clientY)); }}
  onpointerup={(e) => { drag = null; e.currentTarget.releasePointerCapture(e.pointerId); }} onlostpointercapture={() => { drag = null; }}></button>
 <div class="preview-content">
  <header><strong>3D preview</strong><label>Position <select aria-label="Preview position" value={$workspace.previewPosition}
    onchange={(e) => setWorkspace({ previewPosition: e.currentTarget.value as 'right' | 'bottom' })}><option value="bottom">Below</option><option value="right">Beside</option></select></label>
    <button onclick={() => renderer?.reset()} title="Reset preview rotation and zoom">Reset</button>
    <button onclick={togglePreview} aria-label="Close preview" title="Close preview">×</button></header>
<div class="preview" bind:clientWidth={w} bind:clientHeight={h} aria-label="3D preview">
  <canvas bind:this={canvas} aria-label="3D preview surface. Drag to rotate; scroll to zoom."></canvas>
  <div class="surface-overlay compact" bind:this={overlay}></div>
  {#if grid === null}
    <div class="hint">no selection</div>
  {:else if grid.rows < 2 || grid.cols < 2}
    <div class="hint">1D — no surface</div>
  {/if}
</div>
 </div>
</div>

<style>
  .preview-panel { display: flex; flex-direction: column; flex: 0 0 auto; min-height: 160px; max-height: 45%; }
  .preview-panel.right { flex-direction: row; min-height: 0; max-height: none; max-width: 55%; min-width: 240px; }
  .preview-content { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; }
  header { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--bg-panel); font-size: 12px; flex-wrap: wrap; }
  header strong { margin-right: auto; }
  header label { display: flex; gap: 6px; align-items: center; color: var(--fg-dim); }
  .preview { position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--bg); }
  .preview-splitter { flex: 0 0 6px; padding: 0; border: 0; border-radius: 0; background: var(--border); cursor: row-resize; touch-action: none; }
  .right .preview-splitter { cursor: col-resize; }
  .preview-splitter:hover, .preview-splitter:focus-visible { background: var(--accent); }
  @media (max-height: 700px) { .preview-panel:not(.right) { min-height: min(160px, 35%); max-height: 35%; } }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .hint {
    pointer-events: none;
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-dim);
  }
</style>
