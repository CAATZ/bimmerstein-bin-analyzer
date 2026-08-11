<!-- apps/desktop/src/views/MapView.svelte -->
<script lang="ts">
  import { formatPhysical } from '@binanalyzer/core';
  import type { MapDef } from '@binanalyzer/core';
  import { maps, potentialMaps, selection, workingBytes } from '../store/stores.js';
  import { axisLabels, gridFromMap } from '../lib/griddata.js';
  import * as actions from '../store/actions.js';

  const map = $derived.by((): MapDef | undefined => {
    const sel = $selection;
    if (sel?.mapId === undefined) return undefined;
    return [...$maps, ...$potentialMaps].find((m) => m.id === sel.mapId);
  });
  const grid = $derived.by(() => {
    const wb = $workingBytes;
    const m = map;
    return wb && m ? gridFromMap(wb, m) : null;
  });
  const xLabels = $derived.by((): string[] => {
    const wb = $workingBytes;
    const m = map;
    if (!wb || !m) return [];
    return axisLabels(wb, m.xAxis, m.orientation === 'row-major' ? m.cols : m.rows);
  });
  const yLabels = $derived.by((): string[] => {
    const wb = $workingBytes;
    const m = map;
    if (!wb || !m) return [];
    return axisLabels(wb, m.yAxis, m.orientation === 'row-major' ? m.rows : m.cols);
  });

  // Cell selection (spec §7 "cell selection") — view-local display state only;
  // nothing else in the app needs it, so it stays here. Double-click opens an
  // in-cell editor (below); selection alone is still read-only.
  let selectedCell = $state<{ r: number; c: number } | null>(null);
  let shownMapId: string | undefined = $state(undefined);
  $effect(() => {
    // Clear the cell selection whenever the shown map changes.
    if (map?.id !== shownMapId) {
      shownMapId = map?.id;
      selectedCell = null;
    }
  });
  const selectedInfo = $derived.by(() => {
    const g = grid;
    const c = selectedCell;
    const m = map;
    if (!g || !c || !m || c.r >= g.rows || c.c >= g.cols) return null;
    const raw = g.values[c.r]![c.c]!;
    return {
      raw,
      phys: formatPhysical(raw, m.scaling),
      x: xLabels[c.c] ?? String(c.c),
      y: yLabels[c.r] ?? String(c.r),
    };
  });

  let editing = $state<{ r: number; c: number; text: string } | null>(null);

  function beginEdit(r: number, c: number): void {
    const g = grid;
    const m = map;
    if (!g || !m) return;
    editing = { r, c, text: formatPhysical(g.values[r]![c]!, m.scaling) };
  }

  function commitEdit(): void {
    const e = editing;
    const m = map;
    editing = null;
    if (e === null || m === undefined) return;
    const typed = Number(e.text);
    if (!Number.isFinite(typed)) {
      actions.pushToast('error', `"${e.text}" is not a number.`);
      return;
    }
    const res = actions.editCell(m, e.r, e.c, typed);
    if (!res.ok) actions.pushToast('error', res.reason);
    else if (res.clamped) actions.pushToast('info', 'Clamped to the format limit.');
  }
</script>

{#if map === undefined || grid === null}
  <div class="empty">Select a map (sidebar click, F, or K on a selection) to open the spreadsheet view.</div>
{:else}
  <div class="mapview">
    <header>
      <strong>{map.name}</strong>
      <span class="meta">
        0x{map.address.toString(16).toUpperCase()} · {map.rows}×{map.cols} ·
        {map.format.width * 8}-bit {map.format.signed ? 'signed' : 'unsigned'} ·
        {map.scaling.units === '' ? 'raw' : map.scaling.units}
      </span>
      {#if selectedInfo !== null}
        <span class="cell">
          cell [{selectedInfo.y}, {selectedInfo.x}] = {selectedInfo.phys}{map.scaling.units === '' ? '' : ' ' + map.scaling.units}
          (raw {selectedInfo.raw})
        </span>
      {/if}
    </header>
    {#if map.scaling.rawExpression !== undefined}
      <div class="banner">
        Non-affine scaling "{map.scaling.rawExpression}" — showing RAW values (spec §3: never silently mis-scale).
      </div>
    {/if}
    <div class="gridscroll">
      <table>
        <thead>
          <tr>
            <th class="corner">{map.yAxis?.name ?? ''} \ {map.xAxis?.name ?? ''}</th>
            {#each xLabels as label, i (i)}
              <th>{label}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each grid.values as row, r (r)}
            <tr>
              <th>{yLabels[r] ?? String(r)}</th>
              {#each row as v, c (c)}
                <td
                  class:sel={selectedCell?.r === r && selectedCell?.c === c}
                  onclick={() => (selectedCell = { r, c })}
                  ondblclick={() => beginEdit(r, c)}
                >{#if editing?.r === r && editing?.c === c}<input
                      class="celledit"
                      bind:value={editing.text}
                      onblur={commitEdit}
                      onkeydown={(ev) => {
                        if (ev.key === 'Enter') commitEdit();
                        if (ev.key === 'Escape') editing = null;
                      }}
                    />{:else}{formatPhysical(v, map.scaling)}{/if}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}

<style>
  .mapview {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 8px 12px;
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .meta {
    color: var(--fg-dim);
    font-size: 12px;
  }
  .cell {
    color: var(--accent);
    font-size: 12px;
    font-family: Consolas, monospace;
  }
  td {
    cursor: cell;
  }
  td.sel {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    background: #2a3f63;
  }
  .celledit {
    width: 6em;
    font: inherit;
    text-align: right;
    background: var(--bg-raise);
    color: inherit;
    border: 1px solid var(--accent);
  }
  .banner {
    margin: 0 12px 8px;
    padding: 6px 10px;
    background: #4a3a17;
    border-left: 3px solid var(--warn);
    border-radius: 4px;
  }
  .gridscroll {
    flex: 1;
    overflow: auto;
    padding: 0 12px 12px;
  }
  table {
    border-collapse: collapse;
    font-family: Consolas, monospace;
    font-size: 12px;
  }
  th,
  td {
    border: 1px solid #333842;
    padding: 3px 8px;
    text-align: right;
    white-space: nowrap;
  }
  thead th {
    position: sticky;
    top: 0;
    background: var(--bg-raise);
  }
  tbody th {
    position: sticky;
    left: 0;
    background: var(--bg-raise);
  }
  .corner {
    color: var(--fg-dim);
    font-weight: normal;
  }
</style>
