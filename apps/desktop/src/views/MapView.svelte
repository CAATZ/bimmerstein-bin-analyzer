<!-- apps/desktop/src/views/MapView.svelte -->
<script lang="ts">
  import { formatPhysical } from '@binanalyzer/core';
  import type { MapDef } from '@binanalyzer/core';
  import { cellRange, editJournal, maps, potentialMaps, selection, showOriginal, transposeMaps, workingBytes } from '../store/stores.js';
  import { axisLabels, gridFromMap, sourceAxis, sourceCell } from '../lib/griddata.js';
  import { bytesForDisplay, isCellChanged, isUnchangedEdit } from '../lib/diffcells.js';
  import { axisByteOffset, axisEditability, mapsSharingAxis } from '../lib/axisedit.js';
  import * as actions from '../store/actions.js';

  const map = $derived.by((): MapDef | undefined => {
    const sel = $selection;
    if (sel?.mapId === undefined) return undefined;
    return [...$maps, ...$potentialMaps].find((m) => m.id === sel.mapId);
  });
  const transposed = $derived($transposeMaps && map !== undefined && map.rows > 1 && map.cols > 1);
  const xSlot = $derived(sourceAxis('x', transposed, map?.orientation));
  const ySlot = $derived(sourceAxis('y', transposed, map?.orientation));
  const xAxis = $derived(xSlot === 'x' ? map?.xAxis : map?.yAxis);
  const yAxis = $derived(ySlot === 'y' ? map?.yAxis : map?.xAxis);

  // I2 (final whole-branch review): ONE decision — $showOriginal — drives
  // every byte-derived thing F11 shows. The grid AND both axis label lists
  // read this same buffer, so they can never disagree about which state
  // (edited or file-as-opened) is on screen.
  //
  // C2 (CRITICAL regression fix): there is deliberately no intermediate
  // `displayBytes` derived here. `$workingBytes` is mutated IN PLACE by
  // `applyEdit` (same `Uint8Array` reference, just written into) and reset
  // via `workingBytes.set(working)` — so a derived that reads `$workingBytes`
  // and hands back that same reference (the F11-off path) never changes
  // reference. Svelte 5's `$derived` memoizes on `derived.equals`, which
  // defaults to `===`, so its write version would never bump and nothing
  // downstream would ever recompute: the grid would show pre-edit numbers
  // forever, self-correcting only when the buffer reference itself changes
  // (e.g. undo). `bytesForDisplay` is a plain function for exactly this
  // reason — each view-facing derived below calls it directly against the
  // stores it just read, so THIS derived's own recompute (driven by
  // `$workingBytes`/`$showOriginal`/`$editJournal` changing) is what
  // refreshes the screen, not a memoized middle step.
  //
  // `$editJournal` is read UNCONDITIONALLY, before any branch, into a local —
  // never merely inside the F11-on arm of a ternary. `bytesForDisplay` only
  // *uses* the journal when `showOriginal` is true, but Svelte's dependency
  // tracking is per-`$derived`, not per-branch: if the journal read were
  // reachable only from the F11-on side, the F11-off derived would still
  // ostensibly "depend" on it only when that branch runs — and since F11 is
  // off by default, an edit's journal write would never even be visited to
  // discover the dependency, leaving this derived silently stale for the
  // common case. Reading it up front makes it undeniable that every recompute
  // of `grid`/`xLabels`/`yLabels` observes the journal too.
  const grid = $derived.by(() => {
    const w = $workingBytes;
    const showOrig = $showOriginal;
    const journal = $editJournal;
    const m = map;
    if (m === undefined || w === null) return null;
    return gridFromMap(bytesForDisplay(w, showOrig, journal), m, transposed);
  });
  const xLabels = $derived.by((): string[] => {
    const w = $workingBytes;
    const showOrig = $showOriginal;
    const journal = $editJournal;
    const m = map;
    if (!w || !m) return [];
    return axisLabels(bytesForDisplay(w, showOrig, journal), xAxis, grid?.cols ?? 0);
  });
  const yLabels = $derived.by((): string[] => {
    const w = $workingBytes;
    const showOrig = $showOriginal;
    const journal = $editJournal;
    const m = map;
    if (!w || !m) return [];
    return axisLabels(bytesForDisplay(w, showOrig, journal), yAxis, grid?.rows ?? 0);
  });

  /** I3: is the axis breakpoint at `index` on side `which` changed vs the file
   *  as opened? Mirrors `<td>`'s own `isCellChanged` check, keyed on the
   *  axis's own byte offset rather than a cell offset. */
  function axisChanged(which: 'x' | 'y', index: number): boolean {
    const m = map;
    if (m === undefined) return false;
    const axis = which === 'x' ? m.xAxis : m.yAxis;
    const off = axisByteOffset(axis, index);
    if (off === null) return false;
    return isCellChanged($editJournal, off, axis!.format!.width);
  }

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
    const cell = sourceCell(r, c, transposed);
    return rangeCells.has(`${cell.row},${cell.col}`);
  }

  function displayedCellOffset(m: MapDef, r: number, c: number): number {
    const cell = sourceCell(r, c, transposed);
    return actions.cellOffset(m, cell.row, cell.col);
  }

  /** Plain click sets a 1×1 range; shift-click extends it from the existing anchor. */
  function clickCell(r: number, c: number, shiftKey: boolean): void {
    const m = map;
    if (m === undefined) return;
    const cr = $cellRange;
    const cell = sourceCell(r, c, transposed);
    if (shiftKey && cr !== null && cr.mapId === m.id) {
      actions.setCellRange(m.id, cr.r0, cr.c0, cell.row, cell.col);
    } else {
      actions.setCellRange(m.id, cell.row, cell.col, cell.row, cell.col);
    }
  }

  // Info panel shows the range's FOCUS cell (r1,c1) — the far corner of a drag,
  // or the single clicked cell for a 1×1 range.
  const selectedInfo = $derived.by(() => {
    const g = grid;
    const cr = $cellRange;
    const m = map;
    if (!g || !cr || !m || cr.mapId !== m.id) return null;
    const { row: r, col: c } = sourceCell(cr.r1, cr.c1, transposed);
    if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) return null;
    const raw = g.values[r]![c]!;
    return {
      raw,
      phys: formatPhysical(raw, m.scaling),
      x: xLabels[c] ?? String(c),
      y: yLabels[r] ?? String(r),
    };
  });
  const selectedInfoText = $derived(selectedInfo === null ? '' :
    `cell [${selectedInfo.y}, ${selectedInfo.x}] = ${selectedInfo.phys}${map?.scaling.units ? ' ' + map.scaling.units : ''} (raw ${selectedInfo.raw})`);

  // `seed` is the exact text the input opened with (C1, final whole-branch
  // review). commitEdit MUST compare the committed text to `seed` by TEXT —
  // never by parsing both to numbers — because the seed is a display string
  // rounded to `scaling.digits`, and re-quantising it does not reliably land
  // back on the raw byte it was seeded from. Opening a cell and clicking away
  // must never rewrite the byte it merely displayed.
  let editing = $state<{ r: number; c: number; seed: string; text: string } | null>(null);

  function focusEditor(input: HTMLInputElement): void {
    input.focus();
  }

  function beginEdit(r: number, c: number): void {
    const g = grid;
    const m = map;
    if (!g || !m) return;
    const seed = formatPhysical(g.values[r]![c]!, m.scaling);
    editing = { r, c, seed, text: seed };
  }

  function commitEdit(): void {
    const e = editing;
    const m = map;
    editing = null;
    if (e === null || m === undefined) return;
    if (isUnchangedEdit(e.seed, e.text)) return; // C1: no-op edit — never rewrites the byte
    if (e.text.trim() === '') {
      actions.pushToast('error', `"${e.text}" is not a number.`); // M9: Number('') is 0, not NaN
      return;
    }
    const typed = Number(e.text);
    if (!Number.isFinite(typed)) {
      actions.pushToast('error', `"${e.text}" is not a number.`);
      return;
    }
    const cell = sourceCell(e.r, e.c, transposed);
    const res = actions.editCell(m, cell.row, cell.col, typed);
    if (!res.ok) actions.pushToast('error', res.reason);
    else if (res.clamped) actions.pushToast('info', 'Clamped to the format limit.');
  }

  // Axis breakpoint editing (Task 9) — same editing shape as a cell, keyed on
  // which axis and its index instead of a row/col. `axisEditability` gates
  // 'literal'/'index' axes and referenced axes with no format; those show
  // their `reason` on attempt rather than opening an editor.
  // Same C1 seed-text guard as `editing` above.
  let axisEditing = $state<{ which: 'x' | 'y'; index: number; seed: string; text: string } | null>(null);
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
    const seed = (which === xSlot ? xLabels[index] : yLabels[index]) ?? String(index);
    axisEditing = { which, index, seed, text: seed };
  }

  function commitAxisEdit(): void {
    const e = axisEditing;
    const m = map;
    axisEditing = null;
    if (e === null || m === undefined) return;
    if (isUnchangedEdit(e.seed, e.text)) return; // C1: no-op edit — never rewrites the byte
    if (e.text.trim() === '') {
      actions.pushToast('error', `"${e.text}" is not a number.`); // M9: Number('') is 0, not NaN
      return;
    }
    const typed = Number(e.text);
    if (!Number.isFinite(typed)) {
      actions.pushToast('error', `"${e.text}" is not a number.`);
      return;
    }
    const res = actions.editAxisValue(m, e.which, e.index, typed);
    if (!res.ok) actions.pushToast('error', res.reason);
    else if (res.clamped) actions.pushToast('info', 'Clamped to the format limit.');
  }

  /** "Revert selection" undoes only the bytes under the current range. No
   *  usable range means no target (I1) — nothing is reverted, matching what
   *  a '+'/'-' keypress does with nothing selected; the button stays enabled
   *  whenever the journal is non-empty (it doesn't know about the range), so
   *  this must tell the user why nothing happened rather than fail silently. */
  function revertSelection(): void {
    const m = map;
    if (m === undefined) return;
    const cells = actions.cellsForDelta(m, $cellRange);
    if (cells.length === 0) {
      actions.pushToast('info', 'Revert selection needs a cell range — select a range first');
      return;
    }
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
        0x{map.address.toString(16).toUpperCase()} · {grid.rows}×{grid.cols} ·
        {map.format.width * 8}-bit {map.format.signed ? 'signed' : 'unsigned'} ·
        {map.scaling.units === '' ? 'raw' : map.scaling.units}
      </span>
      <span class="cell" title={selectedInfoText}>{selectedInfoText}</span>
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
            <th class="corner" title={`${yAxis?.name ?? ''} \\ ${xAxis?.name ?? ''}`}>
              <span>{yAxis?.name ?? ''} \ {xAxis?.name ?? ''}</span>
            </th>
            {#each xLabels as label, i (i)}
              <th
                class="axishdr"
                class:changed={axisChanged(xSlot, i)}
                ondblclick={() => beginAxisEdit(xSlot, i)}
                >{#if axisEditing?.which === xSlot && axisEditing?.index === i}<input
                    class="celledit"
                    use:focusEditor
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
              <th
                class="axishdr"
                class:changed={axisChanged(ySlot, r)}
                ondblclick={() => beginAxisEdit(ySlot, r)}
                >{#if axisEditing?.which === ySlot && axisEditing?.index === r}<input
                    class="celledit"
                    use:focusEditor
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
                  class:changed={isCellChanged($editJournal, displayedCellOffset(map, r, c), map.format.width)}
                  onclick={(ev) => clickCell(r, c, ev.shiftKey)}
                  ondblclick={() => beginEdit(r, c)}
                >{#if editing?.r === r && editing?.c === c}<input
                      class="celledit"
                      use:focusEditor
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
    /* Keep selection from moving the table between the two clicks of an edit. */
    flex: 0 0 15rem;
    height: 1.5em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
  td.changed,
  th.axishdr.changed {
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
  .corner span {
    display: block;
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
