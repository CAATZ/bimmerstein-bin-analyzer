<!-- apps/desktop/src/views/MapView.svelte -->
<script lang="ts">
  import { formatPhysical } from '@binanalyzer/core';
  import type { MapDef } from '@binanalyzer/core';
  import { cellRange, editJournal, maps, potentialMaps, selection, showOriginal, workingBytes } from '../store/stores.js';
  import { axisLabels, gridFromMap } from '../lib/griddata.js';
  import { isCellChanged, originalGrid } from '../lib/diffcells.js';
  import { axisEditability, mapsSharingAxis } from '../lib/axisedit.js';
  import * as actions from '../store/actions.js';

  const map = $derived.by((): MapDef | undefined => {
    const sel = $selection;
    if (sel?.mapId === undefined) return undefined;
    return [...$maps, ...$potentialMaps].find((m) => m.id === sel.mapId);
  });
  const grid = $derived.by(() => {
    const m = map;
    const w = $workingBytes;
    if (m === undefined || w === null) return null;
    return $showOriginal ? originalGrid(w, $editJournal, m) : gridFromMap(w, m);
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

  // Cell RANGE selection (2026-08-09 amendment) — lives in the store
  // (../store/stores.js `cellRange`), not view-local `$state`: App.svelte's
  // global `+`/`-` handlers need to read it too, to bound a step to the cells
  // the user actually picked instead of the whole map. Double-click still
  // opens the in-cell editor (below), independent of the range.
  let shownMapId: string | undefined = $state(undefined);
  $effect(() => {
    // Clear the range whenever the shown map changes.
    if (map?.id !== shownMapId) {
      shownMapId = map?.id;
      actions.clearCellRange();
      // A shared-axis notice named for the previous map must not survive onto
      // this one — it's the tuner's safety affordance, so a stale name is
      // worse than no name. `sharedNotified` also resets so the new map's
      // axes announce fresh, once each, on their own first edit.
      sharedNames = [];
      sharedNotified.clear();
    }
  });

  /** Cells covered by the current range, as a fast membership set for the grid — empty when the range belongs to a different map (or there is none). */
  const rangeCells = $derived.by((): Set<string> => {
    const cr = $cellRange;
    const m = map;
    if (cr === null || m === undefined || cr.mapId !== m.id) return new Set();
    return new Set(actions.cellsInRange(cr).map((c) => `${c.row},${c.col}`));
  });

  function inRange(r: number, c: number): boolean {
    return rangeCells.has(`${r},${c}`);
  }

  /** Plain click sets a 1×1 range; shift-click extends it from the existing anchor. */
  function clickCell(r: number, c: number, shiftKey: boolean): void {
    const m = map;
    if (m === undefined) return;
    const cr = $cellRange;
    if (shiftKey && cr !== null && cr.mapId === m.id) {
      actions.setCellRange(m.id, cr.r0, cr.c0, r, c);
    } else {
      actions.setCellRange(m.id, r, c, r, c);
    }
  }

  // Info panel shows the range's FOCUS cell (r1,c1) — the far corner of a drag,
  // or the single clicked cell for a 1×1 range.
  const selectedInfo = $derived.by(() => {
    const g = grid;
    const cr = $cellRange;
    const m = map;
    if (!g || !cr || !m || cr.mapId !== m.id) return null;
    const r = cr.r1;
    const c = cr.c1;
    if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) return null;
    const raw = g.values[r]![c]!;
    return {
      raw,
      phys: formatPhysical(raw, m.scaling),
      x: xLabels[c] ?? String(c),
      y: yLabels[r] ?? String(r),
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

  // Axis breakpoint editing (Task 9) — same editing shape as a cell, keyed on
  // which axis and its index instead of a row/col. `axisEditability` gates
  // 'literal'/'index' axes and referenced axes with no format; those show
  // their `reason` on attempt rather than opening an editor.
  let axisEditing = $state<{ which: 'x' | 'y'; index: number; text: string } | null>(null);
  /** Names of other maps whose axis storage overlaps this one, shown once per
   * axis+side before its first edit this session — component-local, not a
   * store, so it never survives a reload and never needs its own reset hook. */
  let sharedNames = $state<string[]>([]);
  const sharedNotified = new Set<string>();

  function beginAxisEdit(which: 'x' | 'y', index: number): void {
    const m = map;
    if (m === undefined) return;
    const axis = which === 'x' ? m.xAxis : m.yAxis;
    const can = axisEditability(axis);
    if (!can.editable) {
      actions.pushToast('error', can.reason ?? 'This axis cannot be edited.');
      return;
    }
    const key = `${m.id}:${which}`;
    if (!sharedNotified.has(key)) {
      sharedNotified.add(key);
      sharedNames = mapsSharingAxis([...$maps, ...$potentialMaps], axis!, m.id);
    } else {
      sharedNames = [];
    }
    const label = which === 'x' ? xLabels[index] : yLabels[index];
    axisEditing = { which, index, text: label ?? String(index) };
  }

  function commitAxisEdit(): void {
    const e = axisEditing;
    const m = map;
    axisEditing = null;
    if (e === null || m === undefined) return;
    const typed = Number(e.text);
    if (!Number.isFinite(typed)) {
      actions.pushToast('error', `"${e.text}" is not a number.`);
      return;
    }
    const res = actions.editAxisValue(m, e.which, e.index, typed);
    if (!res.ok) actions.pushToast('error', res.reason);
    else if (res.clamped) actions.pushToast('info', 'Clamped to the format limit.');
  }

  /** "Revert selection" undoes only the bytes under the current range (or the
   *  whole map with no usable range — same fallback as a step keypress). */
  function revertSelection(): void {
    const m = map;
    if (m === undefined) return;
    const cells = actions.cellsForDelta(m, $cellRange);
    const offsets: number[] = [];
    for (const c of cells) {
      const off = actions.cellOffset(m, c.row, c.col);
      for (let i = 0; i < m.format.width; i++) offsets.push(off + i);
    }
    actions.revertOffsetsAction(offsets);
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
      {#if $showOriginal}
        <span class="origbadge">showing ORIGINAL values (F11)</span>
      {/if}
      {#if sharedNames.length > 0}
        <span class="origbadge">axis shared with {sharedNames.length} other map(s): {sharedNames.join(', ')}</span>
      {/if}
      <span class="grow"></span>
      <button disabled={$editJournal.size === 0} onclick={revertSelection}>Revert selection</button>
      <button disabled={$editJournal.size === 0} onclick={() => actions.revertAll()}>Revert all changes</button>
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
              <th class="axishdr" ondblclick={() => beginAxisEdit('x', i)}
                >{#if axisEditing?.which === 'x' && axisEditing?.index === i}<input
                    class="celledit"
                    bind:value={axisEditing.text}
                    onblur={commitAxisEdit}
                    onkeydown={(ev) => {
                      if (ev.key === 'Enter') commitAxisEdit();
                      if (ev.key === 'Escape') axisEditing = null;
                    }}
                  />{:else}{label}{/if}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each grid.values as row, r (r)}
            <tr>
              <th class="axishdr" ondblclick={() => beginAxisEdit('y', r)}
                >{#if axisEditing?.which === 'y' && axisEditing?.index === r}<input
                    class="celledit"
                    bind:value={axisEditing.text}
                    onblur={commitAxisEdit}
                    onkeydown={(ev) => {
                      if (ev.key === 'Enter') commitAxisEdit();
                      if (ev.key === 'Escape') axisEditing = null;
                    }}
                  />{:else}{yLabels[r] ?? String(r)}{/if}</th>
              {#each row as v, c (c)}
                <td
                  class:inrange={inRange(r, c)}
                  class:changed={isCellChanged($editJournal, actions.cellOffset(map, r, c), map.format.width)}
                  onclick={(ev) => clickCell(r, c, ev.shiftKey)}
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
  header .grow {
    flex: 1;
  }
  .cell {
    color: var(--accent);
    font-size: 12px;
    font-family: Consolas, monospace;
  }
  .origbadge {
    font-size: 12px;
    padding: 1px 6px;
    border-radius: 3px;
    background: #4a3a17;
    border-left: 3px solid var(--warn);
  }
  td {
    cursor: cell;
  }
  th.axishdr {
    cursor: cell;
  }
  td.inrange {
    /* Outline only — no background — so a changed cell inside a range still
       shows td.changed's amber background underneath, legible as both. */
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  td.changed {
    background: #3a2f14;
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
