<!-- apps/desktop/src/views/PreviewPanel.svelte -->
<script lang="ts">
  import { maps, potentialMaps, selection, transposeMaps, viewParams, workingBytes } from '../store/stores.js';
  import { gridFromMap, gridFromSelection, type SurfaceGrid } from '../lib/griddata.js';
  import { SurfaceRenderer } from './surface.js';

  /** Fixed-size always-on-top overlay (locked decision 1) — the
      "am I looking at a map?" feedback loop, live on every selection change. */
  const W = 260;
  const H = 200;

  let canvas: HTMLCanvasElement;
  let renderer: SurfaceRenderer | null = null;

  const grid = $derived.by((): SurfaceGrid | null => {
    const wb = $workingBytes;
    const sel = $selection;
    if (!wb || !sel) return null;
    if (sel.mapId !== undefined) {
      const m = [...$maps, ...$potentialMaps].find((x) => x.id === sel.mapId);
      if (m) return gridFromMap(wb, m, $transposeMaps);
    }
    return gridFromSelection(wb, sel.start, sel.end, sel.cols ?? $viewParams.columns, $viewParams.format);
  });

  $effect(() => {
    renderer = new SurfaceRenderer(canvas, false);
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

<div class="preview" style="width: {W}px; height: {H}px;">
  <canvas bind:this={canvas}></canvas>
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
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-dim);
  }
</style>
