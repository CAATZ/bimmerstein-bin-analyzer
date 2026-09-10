<!-- apps/desktop/src/views/PreviewPanel.svelte -->
<script lang="ts">
  import { maps, potentialMaps, selection, transposeMaps, viewParams, workingBytes } from '../store/stores.js';
  import { surfaceFromMap, gridFromSelection, type SurfaceGrid } from '../lib/griddata.js';
  import { SurfaceRenderer } from './surface.js';

  const W = 320;
  const H = 250;

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
    renderer.resize(W, H, window.devicePixelRatio || 1);
    return () => {
      renderer?.dispose();
      renderer = null;
    };
  });
  $effect(() => {
    renderer?.setGrid(grid);
  });
</script>

<div class="preview" style="width: {W}px; height: {H}px;" aria-label="3D preview">
  <canvas bind:this={canvas} aria-label="3D preview surface. Drag to rotate; scroll to zoom."></canvas>
  <div class="surface-overlay compact" bind:this={overlay}></div>
  <button class="surface-reset" onclick={() => renderer?.reset()} title="Reset preview rotation and zoom">Reset</button>
  {#if grid === null}
    <div class="hint">no selection</div>
  {:else if grid.rows < 2 || grid.cols < 2}
    <div class="hint">1D — no surface</div>
  {/if}
</div>

<style>
  .preview {
    position: fixed;
    right: 14px;
    bottom: 40px;
    z-index: 30;
    border: 1px solid #3a3f48;
    border-radius: 6px;
    overflow: hidden;
    background: var(--bg);
    box-shadow: 0 4px 18px rgb(0 0 0 / 60%);
  }
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
