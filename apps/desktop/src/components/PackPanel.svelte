<!-- apps/desktop/src/components/PackPanel.svelte -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { formatPhysical, type Scaling } from '@binanalyzer/core';
  import { applyPackRows, popModal, pushModal, pushToast } from '../store/actions.js';
  import { pendingPack } from '../store/stores.js';
  import { initialPackChecked, type PackRow } from '../lib/packapply.js';

  let checked = $state<Record<number, boolean>>({});
  let expanded = $state<Record<number, boolean>>({});
  let trapped = false;

  const current = $derived($pendingPack);

  $effect(() => {
    const p = $pendingPack;
    checked = p === null ? {} : initialPackChecked(p.rows);
    expanded = {};
  });

  // The panel owns the keyboard while it is up, like every other modal here.
  $effect(() => {
    const open = $pendingPack !== null;
    if (open && !trapped) {
      pushModal();
      trapped = true;
    } else if (!open && trapped) {
      popModal();
      trapped = false;
    }
  });

  onDestroy(() => {
    if (trapped) popModal();
  });

  const chosen = $derived(
    current === null
      ? []
      : current.rows.filter((r) => checked[r.index] === true && r.klass !== 'incompatible')
  );
  const modifiedCount = $derived(
    current === null ? 0 : current.rows.filter((r) => r.klass === 'modified').length
  );

  /**
   * formatPhysical takes a RAW value and applies the scaling itself — never
   * pre-convert with toPhysical, or every number here is scaled twice.
   */
  const phys = (raw: number, scaling: Scaling): string => formatPhysical(raw, scaling);
  const hex = (n: number): string => n.toString(16).toUpperCase();
  const changedCellsOf = (r: PackRow) => r.cells.filter((c) => c.before !== c.after);

  function apply(): void {
    const out = applyPackRows(chosen);
    pushToast(
      'info',
      `Applied ${out.tables} table${out.tables === 1 ? '' : 's'}, ${out.changedBytes} byte${out.changedBytes === 1 ? '' : 's'} changed`
    );
    pendingPack.set(null);
  }
</script>

{#if current !== null}
  <div class="backdrop">
    <div class="panel" role="dialog" aria-modal="true" aria-label={current.pack.title}>
      <h2>{current.pack.title}</h2>
      <p class="reason">from {current.fileName} · calibration {current.pack.source.calId}</p>
      {#if current.pack.notes}<p class="reason">{current.pack.notes}</p>{/if}
      <p class="count">
        {current.rows.length} table{current.rows.length === 1 ? '' : 's'} — {chosen.length} selected
      </p>

      {#if modifiedCount > 0}
        <p class="warn">
          {modifiedCount} table{modifiedCount === 1 ? '' : 's'} in this bin already {modifiedCount === 1
            ? 'differs'
            : 'differ'} from what the pack's author started from. Expand a row to see which cells.
        </p>
      {/if}

      <ul class="rows">
        {#each current.rows as r (r.index)}
          <li>
            <label>
              <input type="checkbox" bind:checked={checked[r.index]} disabled={r.klass === 'incompatible'} />
              <span class="tname">{r.name}</span>
              <span class="dim">{r.rows}×{r.cols} @ 0x{hex(r.address)}</span>
              {#if r.klass === 'incompatible'}
                <span class="err">{r.reason}</span>
              {:else}
                <span class="phys">{r.changedCells} of {r.cells.length} cells change</span>
                {#if r.klass === 'modified'}<span class="flag warn-flag">modified here</span>{/if}
                {#if r.klass === 'no-change'}<span class="flag">no change</span>{/if}
                <button class="link" onclick={() => (expanded[r.index] = !expanded[r.index])}>
                  {expanded[r.index] ? 'hide' : 'cells'}
                </button>
              {/if}
            </label>

            {#if expanded[r.index] === true}
              <ul class="cells">
                {#each changedCellsOf(r) as c (`${c.row}:${c.col}`)}
                  <li>
                    <span class="cellname">[{c.row}, {c.col}]</span>
                    <span class="phys">
                      {phys(c.before, r.table.scaling)} → {phys(c.after, r.table.scaling)}
                    </span>
                    <span class="raw">raw 0x{hex(c.before)} → 0x{hex(c.after)}</span>
                  </li>
                {/each}
                {#each r.divergedCells as d (`d${d.row}:${d.col}`)}
                  <li class="diverged">
                    <span class="cellname">[{d.row}, {d.col}]</span>
                    <span class="warn">yours {d.mine}, author started from {d.theirBaseline}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="actions">
        <button onclick={() => pendingPack.set(null)}>Cancel</button>
        <button class="primary" disabled={chosen.length === 0} onclick={apply}>
          Apply {chosen.length}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 45%);
    z-index: 40;
  }
  .panel {
    display: flex;
    flex-direction: column;
    max-height: 80vh;
    max-width: min(52rem, 92vw);
    min-width: min(34rem, 90vw);
    padding: 1rem;
    gap: 0.5rem;
    background: var(--bg-panel);
    color: var(--fg);
    border: 1px solid var(--bg-raise);
    border-radius: 6px;
  }
  h2 { margin: 0; font-size: 1.05rem; }
  .count, .reason { margin: 0; color: var(--fg-dim); }
  .warn { margin: 0; color: var(--fg-warn, #d08000); flex: 0 0 auto; }
  /* Scrolls in ITS OWN container — the Axis Library failure mode, twice seen. */
  .rows {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    margin: 0;
    padding: 0.25rem 0;
    list-style: none;
    border-top: 1px solid var(--bg-raise);
    border-bottom: 1px solid var(--bg-raise);
  }
  .rows > li { padding: 0.15rem 0; }
  .rows label { display: flex; gap: 0.5rem; align-items: baseline; cursor: pointer; }
  .tname { min-width: 12rem; }
  .dim, .raw, .flag { color: var(--fg-dim); font-size: 0.85em; }
  .warn-flag { color: var(--fg-warn, #d08000); }
  .phys { font-variant-numeric: tabular-nums; }
  .err { color: var(--fg-error, #c04040); }
  .cells { list-style: none; margin: 0.15rem 0 0.4rem 2rem; padding: 0; }
  .cells li { display: flex; gap: 0.5rem; font-size: 0.9em; }
  .cellname { min-width: 5rem; }
  .diverged { color: var(--fg-warn, #d08000); }
  .link {
    background: none;
    border: none;
    color: var(--fg-dim);
    text-decoration: underline;
    cursor: pointer;
    padding: 0;
  }
  .actions { display: flex; gap: 0.5rem; justify-content: flex-end; flex: 0 0 auto; }
  .primary { font-weight: 600; }
</style>
