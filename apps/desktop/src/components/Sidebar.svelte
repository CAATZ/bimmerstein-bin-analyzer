<!-- apps/desktop/src/components/Sidebar.svelte -->
<script lang="ts">
  import type { MapDef, DetectorTier } from '@binanalyzer/core';
  import { maps, potentialMaps, selection } from '../store/stores.js';
  import * as actions from '../store/actions.js';
  import { isCurveShaped } from '../lib/curvedata.js';
  import { isSwitch } from '../lib/switchdata.js';
  import MapPropertiesDialog from './MapPropertiesDialog.svelte';

  let editing: MapDef | null = $state(null);

  // Detection-tier badge (spec §4.5/§4.6): evidence strength strongest → weakest.
  const TIER: Record<DetectorTier, { label: string; title: string }> = {
    family: { label: 'code', title: 'Code-xref proven — a cal-reader CALL site references this address (full reads only)' },
    structural: { label: 'struct', title: 'Placed from a count-prefixed axis pair’s stored lengths' },
    pool: { label: 'pool', title: 'Byte-detected, bound to a shared count-prefixed axis pair' },
    generic: { label: 'byte', title: 'Byte-smoothness heuristic only' },
  };
</script>

<aside class="sidebar">
  <h2>Maps ({$maps.length})</h2>
  <ul>
    {#each $maps as m (m.id)}
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
  <h2>Potential maps ({$potentialMaps.length})</h2>
  <ul>
    <!-- ENGINE RANK ORDER — locked decision 3; never re-sort. -->
    {#each $potentialMaps as m (m.id)}
      {@const tier = m.detector ? TIER[m.detector] : undefined}
      <li class:selected={$selection?.mapId === m.id}>
        <button
          class="row"
          title="{m.name} — click: select+jump · double-click: promote"
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
          <span class="conf">{Math.round((m.confidence ?? 0) * 100)}%</span>
        </button>
      </li>
    {/each}
  </ul>
</aside>

{#if editing !== null}
  <MapPropertiesDialog map={editing} onclose={() => (editing = null)} />
{/if}
