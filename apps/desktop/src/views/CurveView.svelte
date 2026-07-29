<!-- apps/desktop/src/views/CurveView.svelte -->
<script lang="ts">
  import { bin, maps, potentialMaps, selection } from '../store/stores.js';
  import { curveSeries } from '../lib/curvedata.js';
  import { formatPhysical } from '@binanalyzer/core';
  import type { MapDef } from '@binanalyzer/core';

  const map = $derived.by((): MapDef | undefined => {
    const sel = $selection;
    if (!sel || sel.mapId === undefined) return undefined;
    return [...$maps, ...$potentialMaps].find((x) => x.id === sel.mapId);
  });
  const series = $derived.by(() => {
    const image = $bin;
    const m = map;
    if (!image || !m) return undefined;
    return curveSeries(image.bytes, m);
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
</script>

<div class="curvewrap">
  {#if map && series && series.y.length > 0}
    <div class="head">
      {map.name} — {series.y.length} points{series.xIsIndex ? ' (no axis bound — index X)' : ''}
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
    <table class="vals">
      <thead>
        <tr>
          <th>{series.xIsIndex ? '#' : (series.axis?.name ?? 'axis')}</th>
          <th>value{map.scaling.units ? ` (${map.scaling.units})` : ''}</th>
        </tr>
      </thead>
      <tbody>
        {#each series.y as yv, i (i)}
          <tr>
            <td>{fmtX(series.x[i]!)}</td>
            <td>{fmtY(yv, map.scaling.digits)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
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
  }
  .head {
    margin-bottom: 6px;
    color: var(--fg-dim);
    font-size: 12px;
  }
  .chart {
    width: 100%;
    max-width: 760px;
    background: var(--bg-panel);
    border: 1px solid #333842;
    border-radius: 4px;
  }
  .tick {
    fill: var(--fg-dim);
    font-size: 10px;
  }
  .vals {
    margin-top: 10px;
    border-collapse: collapse;
    font-family: Consolas, monospace;
    font-size: 12px;
  }
  .vals th,
  .vals td {
    border: 1px solid #333842;
    padding: 3px 8px;
    text-align: right;
    white-space: nowrap;
  }
  .vals thead th {
    position: sticky;
    top: 0;
    background: var(--bg-raise);
  }
</style>
