<!-- apps/desktop/src/components/Sidebar.svelte -->
<script lang="ts">
  import type { MapDef } from '@binanalyzer/core';
  import { mapFilter, maps, potentialMaps, selection } from '../store/stores.js';
  import * as actions from '../store/actions.js';
  import { isCurveShaped } from '../lib/curvedata.js';
  import { isSwitch } from '../lib/switchdata.js';
  import MapPropertiesDialog from './MapPropertiesDialog.svelte';
  import { DEFAULT_MAP_FILTER, DETECTION_METHODS, detectionDescription, filterMaps, type MapFilter } from '../lib/mapfilter.js';

  let editing: MapDef | null = $state(null);
  let panel: HTMLDivElement;
  let width = $state(260);
  let drag: { x: number; width: number } | null = null;

  function resize(next: number): void {
    width = Math.round(Math.max(180, Math.min(next, (panel.parentElement?.clientWidth ?? 1000) * 0.6)));
  }

  function resizeKey(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    resize(event.key === 'Home' ? 260 : panel.clientWidth + (event.key === 'ArrowRight' ? 20 : -20));
  }

  const shownMaps = $derived(filterMaps($maps, $mapFilter));
  const shownPotential = $derived(filterMaps($potentialMaps, $mapFilter));
  const selectedPotential = $derived($potentialMaps.find((m) => m.id === $selection?.mapId));
  const filtered = $derived($mapFilter.query !== '' || $mapFilter.shape !== 'all' || $mapFilter.detector !== 'all');
</script>

<div class="sidebar-panel" bind:this={panel} style:width="{width}px">
<aside class="sidebar" id="map-sidebar" aria-label="Maps">
  <div class="filters">
    <input type="search" aria-label="Search maps" placeholder="Name, address or 20x16" value={$mapFilter.query}
      oninput={(e) => actions.setMapFilter({ ...$mapFilter, query: e.currentTarget.value })} />
    <div class="filter-row">
      <select aria-label="Table shape" value={$mapFilter.shape}
        onchange={(e) => actions.setMapFilter({ ...$mapFilter, shape: e.currentTarget.value as MapFilter['shape'] })}>
        <option value="all">All shapes</option><option value="grid">Tables</option><option value="curve">Curves</option><option value="switch">Switches</option>
      </select>
      <select aria-label="Detection method" value={$mapFilter.detector}
        onchange={(e) => actions.setMapFilter({ ...$mapFilter, detector: e.currentTarget.value as MapFilter['detector'] })}>
        <option value="all">All methods</option><option value="family">Family</option><option value="structural">Structural</option><option value="pool">Shared axes</option><option value="generic">Byte patterns</option>
      </select>
    </div>
    {#if filtered}<button onclick={() => actions.setMapFilter(DEFAULT_MAP_FILTER)}>Clear filters</button>{/if}
  </div>
  <p class="evidence" aria-label="Detection evidence">{selectedPotential
    ? detectionDescription(selectedPotential)
    : 'Select a potential map for detection evidence.'}</p>
  <h2>Maps ({filtered ? `${shownMaps.length}/` : ''}{$maps.length})</h2>
  <ul>
    {#each shownMaps as m (m.id)}
      <li class:selected={$selection?.mapId === m.id}>
        <button class="row" onclick={() => actions.selectMap(m)} title={m.name}>
          <span class="name">{m.name}</span>
          {#if isSwitch(m)}
            <span class="sw" title="Switch (named-state table)">SW</span>
          {:else if isCurveShaped(m)}
            <span class="oned" title="1D curve (single-axis table)">1D</span>
          {/if}
          <span class="addr">0x{m.address.toString(16).toUpperCase()}</span>
        </button>
        <button class="x" title="Properties" onclick={() => (editing = m)}>✎</button>
        <button class="x" title="Remove map" onclick={() => actions.removeMap(m.id)}>×</button>
      </li>
    {/each}
  </ul>
  <h2>Potential maps ({filtered ? `${shownPotential.length}/` : ''}{$potentialMaps.length})</h2>
  <ul>
    <!-- ENGINE RANK ORDER — locked decision 3; never re-sort. -->
    {#each shownPotential as m (m.id)}
      {@const tier = m.detector ? DETECTION_METHODS[m.detector] : undefined}
      <li class:selected={$selection?.mapId === m.id}>
        <button
          class="row"
          title="{m.name} — {detectionDescription(m)} Click: select+jump · double-click: promote"
          onclick={() => actions.selectMap(m)}
          ondblclick={() => {
            if (actions.promoteMap(m.id)) actions.pushToast('info', `Promoted ${m.name}`);
          }}
        >
          <span class="name">{m.name}</span>
          {#if tier}
            <span class="tier tier-{m.detector}" title={tier.title}>{tier.label}</span>
          {/if}
          {#if isSwitch(m)}
            <span class="sw" title="Switch (named-state table)">SW</span>
          {:else if isCurveShaped(m)}
            <span class="oned" title="1D curve (single-axis table)">1D</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if filtered && shownMaps.length === 0 && shownPotential.length === 0}<p class="no-results" role="status">No maps match these filters.</p>{/if}
</aside>
<button class="splitter" type="button" aria-label="Resize map sidebar"
  aria-controls="map-sidebar"
  title="Drag to resize. Arrow keys adjust width; Home or double-click resets."
  onkeydown={resizeKey} ondblclick={() => resize(260)}
  onpointerdown={(e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    drag = { x: e.clientX, width: panel.clientWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  }}
  onpointermove={(e) => { if (drag) resize(drag.width + e.clientX - drag.x); }}
  onpointerup={(e) => { drag = null; e.currentTarget.releasePointerCapture(e.pointerId); }}
  onlostpointercapture={() => { drag = null; }}></button>
</div>

{#if editing !== null}
  <MapPropertiesDialog map={editing} onclose={() => (editing = null)} />
{/if}

<style>
  .sidebar-panel { display: flex; flex: 0 0 auto; min-width: 180px; max-width: 60%; }
  .splitter { flex: 0 0 6px; padding: 0; border: 0; border-radius: 0; cursor: col-resize; touch-action: none; background: #333842; }
  .splitter:hover, .splitter:focus-visible { background: var(--accent); outline: none; }
  .filters { position: sticky; top: -6px; background: var(--bg-panel); padding: 6px 0; z-index: 1; }
  .filters input { box-sizing: border-box; width: 100%; }
  .filter-row { display: flex; gap: 4px; margin: 4px 0; }
  .filter-row select { width: 50%; min-width: 0; }
  .evidence, .no-results { font-size: 12px; color: var(--fg-dim); margin: 8px 4px; line-height: 1.4; }
  .evidence { height: 5.6em; overflow: auto; }
</style>
