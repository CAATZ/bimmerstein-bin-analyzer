<!-- apps/desktop/src/views/View3d.svelte -->
<script lang="ts">
  import { maps, potentialMaps, selection, transposeMaps, viewParams, workingBytes } from '../store/stores.js';
  import { gridFromMap, gridFromSelection, type SurfaceGrid } from '../lib/griddata.js';
  import { SurfaceRenderer } from './surface.js';

  let canvas: HTMLCanvasElement;
  let w = $state(0);
  let h = $state(0);
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
    renderer = new SurfaceRenderer(canvas, true);
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

<div class="wrap3d" bind:clientWidth={w} bind:clientHeight={h}>
  <canvas bind:this={canvas}></canvas>
  {#if grid === null}
    <div class="hint">Select a range or map (needs ≥ 2 rows × 2 cols at the current framing).</div>
  {:else if grid.rows < 2 || grid.cols < 2}
    <div class="hint">1D curve / area too small — no 3D surface. Switch to the Map view (F) to see the curve chart.</div>
  {/if}
</div>

<style>
  .wrap3d {
    position: absolute;
    inset: 0;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .hint {
    position: absolute;
    inset: auto 0 12px 0;
    text-align: center;
    color: var(--fg-dim);
    pointer-events: none;
  }
</style>
