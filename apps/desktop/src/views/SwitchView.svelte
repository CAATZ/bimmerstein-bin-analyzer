<!-- apps/desktop/src/views/SwitchView.svelte -->
<script lang="ts">
  import { maps, potentialMaps, selection, workingBytes } from '../store/stores.js';
  import { isSwitch, matchSwitchState } from '../lib/switchdata.js';
  import type { MapDef } from '@binanalyzer/core';

  const map = $derived.by((): MapDef | undefined => {
    const sel = $selection;
    if (!sel || sel.mapId === undefined) return undefined;
    return [...$maps, ...$potentialMaps].find((x) => x.id === sel.mapId);
  });
  const match = $derived.by(() => {
    const wb = $workingBytes;
    const m = map;
    if (!wb || !m || !isSwitch(m)) return undefined;
    return matchSwitchState(wb, m);
  });
  /** Index of the row to highlight — the FIRST state whose DATA equals the
   *  actual bytes (matchSwitchState matches by data; duplicate NAMES may
   *  carry different data, so a name lookup could highlight the wrong row —
   *  the first data-equal row IS the matched row by construction). */
  const matchedIndex = $derived.by((): number => {
    const m = map;
    const r = match;
    if (!m?.states || !r || r.matched === undefined) return -1;
    return m.states.findIndex((s) => s.data.length === r.actual.length && s.data.every((b, i) => b === r.actual[i]));
  });
  const hex = (data: number[]): string =>
    data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
</script>

<div class="switchwrap">
  {#if map && map.states && match}
    <div class="head">
      {map.name} — {map.rows} byte{map.rows === 1 ? '' : 's'} @ 0x{map.address.toString(16).toUpperCase()}{map.category ? ` · ${map.category}` : ''}
    </div>
    {#if match.matched !== undefined}
      <div class="verdict matched">State: {match.matched}</div>
    {:else if match.actual.length < map.rows}
      <div class="verdict oob">Outside the loaded region — {match.actual.length} of {map.rows} byte(s) readable</div>
    {:else}
      <div class="verdict custom">Custom — matches no defined state ({hex(match.actual)})</div>
    {/if}
    <table class="states">
      <thead>
        <tr><th>state</th><th>pattern</th></tr>
      </thead>
      <tbody>
        {#each map.states as s, i (i)}
          <tr class:hit={i === matchedIndex}>
            <td>{s.name}</td>
            <td class="pat">{hex(s.data)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <div class="empty">Select a switch to view it.</div>
  {/if}
</div>

<style>
  .switchwrap {
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
  .verdict {
    display: inline-block;
    margin-bottom: 10px;
    padding: 4px 10px;
    border: 1px solid #333842;
    border-radius: 4px;
    font-size: 13px;
  }
  .verdict.matched {
    color: var(--accent);
  }
  .verdict.custom,
  .verdict.oob {
    color: var(--fg-dim);
  }
  .states {
    border-collapse: collapse;
    font-size: 12px;
  }
  .states th,
  .states td {
    border: 1px solid #333842;
    padding: 3px 8px;
    text-align: left;
    white-space: nowrap;
  }
  .states thead th {
    position: sticky;
    top: 0;
    background: var(--bg-raise);
  }
  .states td.pat {
    font-family: Consolas, monospace;
  }
  .states tr.hit td {
    background: var(--bg-raise);
    color: var(--accent);
  }
</style>
