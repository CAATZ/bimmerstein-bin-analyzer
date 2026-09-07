<!-- apps/desktop/src/views/CurveView.svelte -->
<script lang="ts">
  import { editJournal, maps, potentialMaps, selection, showOriginal, workingBytes } from '../store/stores.js';
  import { curveSeries } from '../lib/curvedata.js';
  import { bytesForDisplay } from '../lib/diffcells.js';
  import { formatPhysical } from '@binanalyzer/core';
  import type { MapDef } from '@binanalyzer/core';
  import * as actions from '../store/actions.js';
  import { entryAxisFromCurve } from '../lib/axislib.js';
  import MapView from './MapView.svelte';

  const map = $derived.by((): MapDef | undefined => {
    const sel = $selection;
    if (!sel || sel.mapId === undefined) return undefined;
    return [...$maps, ...$potentialMaps].find((x) => x.id === sel.mapId);
  });
  const series = $derived.by(() => {
    const wb = $workingBytes;
    const original = $showOriginal;
    const journal = $editJournal;
    const m = map;
    if (!wb || !m) return undefined;
    return curveSeries(bytesForDisplay(wb, original, journal), m);
  });

  const W = 640;
  const H = 260;
  const PAD = 36;

  /** Pixel-space points for the polyline + markers. */
  const points = $derived.by((): { sx: number; sy: number }[] => {
    const s = series;
    if (!s || s.y.length === 0) return [];
    const xMin = Math.min(...s.x);
    const xMax = Math.max(...s.x);
    const yMin = Math.min(...s.y);
    const yMax = Math.max(...s.y);
    const sx = (v: number): number => PAD + ((v - xMin) / Math.max(1e-9, xMax - xMin)) * (W - 2 * PAD);
    const sy = (v: number): number => H - PAD - ((v - yMin) / Math.max(1e-9, yMax - yMin)) * (H - 2 * PAD);
    return s.x.map((xv, i) => ({ sx: sx(xv), sy: sy(s.y[i]!) }));
  });
  const pts = $derived.by(() => points.map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' '));

  /** series.y is already physical (curveSeries applies toPhysical) — format digits only,
   *  never re-scale (formatPhysical would re-apply factor/offset — see task-4-report). */
  function fmtY(y: number, digits: number): string {
    return y.toFixed(Math.max(0, Math.trunc(digits)));
  }
  /** series.x is a raw axis cell value (or a plain index) — apply the axis's own scaling
   *  for display, matching griddata's axisLabels convention. */
  function fmtX(xv: number): string {
    const s = series;
    if (!s || s.xIsIndex) return String(xv);
    const axisScaling = s.axis?.scaling;
    return axisScaling ? formatPhysical(xv, axisScaling) : String(xv);
  }

  function saveAsAxis(): void {
    const m = map;
    if (!m) return;
    const r = actions.addAxisLibEntry(m.name, entryAxisFromCurve(m));
    if (r.ok) actions.pushToast('info', `Saved "${r.value.name}" to the axis library`);
    else actions.pushToast('error', r.error);
  }
</script>

<div class="curvewrap">
  {#if map && series && series.y.length > 0}
    <div class="head">
      {map.name} — {series.y.length} points{series.xIsIndex ? ' (no axis bound — index X)' : ''}
      <button class="saveaxis" onclick={saveAsAxis} title="Create an axis library entry from this curve's data span (a detected curve is often a shared axis)">Save as axis</button>
    </div>
    <svg viewBox="0 0 {W} {H}" class="chart" role="img" aria-label="curve chart">
      <polyline points={pts} fill="none" stroke="var(--accent)" stroke-width="1.5" />
      {#each points as p, i (i)}
        <circle cx={p.sx} cy={p.sy} r="2.5" fill="var(--accent)" />
      {/each}
      <text x={PAD} y={H - 8} class="tick">{fmtX(series.x[0]!)}</text>
      <text x={W - PAD} y={H - 8} class="tick" text-anchor="end">{fmtX(series.x[series.y.length - 1]!)}</text>
      <text x={6} y={PAD} class="tick">{fmtY(Math.max(...series.y), map.scaling.digits)}</text>
      <text x={6} y={H - PAD} class="tick">{fmtY(Math.min(...series.y), map.scaling.digits)}</text>
    </svg>
    <div class="editor"><MapView /></div>
  {:else}
    <div class="empty">Select a 1D curve to view it.</div>
  {/if}
</div>

<style>
  .curvewrap {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
  }
  .head {
    margin-bottom: 6px;
    color: var(--fg-dim);
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .saveaxis {
    margin-left: auto;
  }
  .chart {
    width: 100%;
    max-width: 760px;
    height: 220px;
    flex-shrink: 0;
    background: var(--bg-panel);
    border: 1px solid #333842;
    border-radius: 4px;
  }
  .tick {
    fill: var(--fg-dim);
    font-size: 10px;
  }
  .editor {
    position: relative;
    flex: 1;
    min-height: 280px;
    margin-top: 10px;
  }
</style>
