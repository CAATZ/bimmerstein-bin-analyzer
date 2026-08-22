<!-- apps/desktop/src/components/ProposalPanel.svelte -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { popModal, pushModal } from '../store/actions.js';
  import { maps, potentialMaps, proposals, workingBytes, type ProposedChange } from '../store/stores.js';
  import {
    initialChecked, isEditRow, nonMonotonicAxes, previewEdits, type PreviewInput,
  } from '../lib/editpreview.js';

  let { onDecide }: { onDecide: (requestId: string, acceptedIds: string[]) => void } = $props();

  const proposal = $derived($proposals[0]);
  let checked = $state<Record<string, boolean>>({});
  let trapped = false;

  // Byte rows and metadata rows render differently: the numbers ARE the
  // decision for a value edit (Part C §5), so they never go through describe().
  const editRows = $derived(
    proposal === undefined ? [] : (proposal.changes.filter(isEditRow) as unknown as PreviewInput[])
  );
  const metaRows = $derived(proposal === undefined ? [] : proposal.changes.filter((c) => !isEditRow(c)));

  const groups = $derived(
    editRows.length === 0 || $workingBytes === null
      ? []
      : previewEdits({ rows: editRows, maps: $maps, potentials: $potentialMaps, working: $workingBytes })
  );

  const staleCount = $derived(groups.flatMap((g) => g.rows).filter((r) => r.stale).length);

  const outOfOrder = $derived(
    editRows.length === 0 || $workingBytes === null
      ? []
      : nonMonotonicAxes({
          rows: editRows,
          checkedIds: new Set(Object.entries(checked).filter(([, on]) => on).map(([id]) => id)),
          maps: $maps, potentials: $potentialMaps, working: $workingBytes,
        })
  );

  // Metadata rows start checked — on a 306-map import "accept it all" is the
  // common case. Byte rows defer to initialChecked, which leaves stale and
  // unresolvable rows OFF.
  $effect(() => {
    const p = $proposals[0];
    if (p === undefined) {
      checked = {};
      return;
    }
    const meta = Object.fromEntries(p.changes.filter((c) => !isEditRow(c)).map((c) => [c.id, true]));
    checked = { ...meta, ...initialChecked(groups) };
  });

  // The panel owns the keyboard while it is up, like every other modal here.
  $effect(() => {
    const open = $proposals.length > 0;
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

  const acceptedIds = $derived(
    proposal === undefined ? [] : proposal.changes.filter((c) => checked[c.id] === true).map((c) => c.id)
  );

  function describe(change: ProposedChange): string {
    if (change['addMap'] !== undefined) {
      const m = change['addMap'] as { name?: string; address?: number };
      return `add "${m.name ?? '?'}" at 0x${(m.address ?? 0).toString(16).toUpperCase()}`;
    }
    const target = String(change['mapId'] ?? change['entryId'] ?? 'new axis entry');
    const fields = Object.keys(change).filter(
      (k) => k !== 'id' && k !== 'mapId' && k !== 'entryId' && k !== 'op'
    );
    return `${target}: ${fields.join(', ')}`;
  }

  const setAll = (value: boolean): void => {
    checked = proposal === undefined ? {} : Object.fromEntries(proposal.changes.map((c) => [c.id, value]));
  };
</script>

{#if proposal !== undefined}
  <div class="backdrop">
    <div class="panel" role="dialog" aria-modal="true" aria-label={proposal.title}>
      <h2>{proposal.title}</h2>
      {#if proposal.reason}<p class="reason">{proposal.reason}</p>{/if}
      <p class="count">
        {proposal.changes.length} proposed change{proposal.changes.length === 1 ? '' : 's'} — {acceptedIds.length} selected
      </p>

      <div class="actions-top">
        <button onclick={() => setAll(true)}>Select all</button>
        <button onclick={() => setAll(false)}>Select none</button>
      </div>

      {#if staleCount > 0}
        <p class="warn">
          Authored against a buffer that has since changed — {staleCount} of
          {editRows.length} rows no longer match what the co-pilot saw. They start unchecked.
        </p>
      {/if}
      {#if outOfOrder.length > 0}
        <p class="warn">
          With these rows checked, {outOfOrder.join(', ')} would no longer be in order.
          The ECU will still interpolate across it.
        </p>
      {/if}

      <!-- Byte rows: the numbers are the decision, so physical AND raw,
           before AND after, with every flag computed by a dry run. -->
      {#each groups as group (group.mapId)}
        <h3 class="group">{group.mapName} — {group.summary}</h3>
        <ul class="rows">
          {#each group.rows as row (row.id)}
            <li class:stale={row.stale}>
              <label>
                <input type="checkbox" bind:checked={checked[row.id]} disabled={row.error !== undefined} />
                <span class="cellname">{row.label}</span>
                {#if row.error}
                  <span class="err">{row.error}</span>
                {:else}
                  <span class="phys">{row.beforePhysical} → {row.afterPhysical}</span>
                  <span class="raw">
                    raw 0x{row.beforeRaw.toString(16).toUpperCase()} → 0x{row.afterRaw.toString(16).toUpperCase()}
                  </span>
                  {#if row.clamped}<span class="flag">clamped</span>{/if}
                  {#if row.noChange}<span class="flag">no change</span>{/if}
                  {#if row.stale}<span class="flag">stale</span>{/if}
                  {#if row.shared.length > 0}
                    <span class="flag">shared with {row.shared.length}: {row.shared.join(', ')}</span>
                  {/if}
                {/if}
              </label>
            </li>
          {/each}
        </ul>
      {/each}

      <!-- Scrolls in ITS OWN container. At 306 rows a flex child with
           overflow:visible defeats the panel's max-height and pushes the
           buttons off-screen — exactly how the Axis Library attach dialog
           broke at 216 rows (2026-07-30). -->
      <ul class="rows">
        {#each metaRows as change (change.id)}
          <li>
            <label>
              <input type="checkbox" bind:checked={checked[change.id]} />
              <span>{describe(change)}</span>
            </label>
          </li>
        {/each}
      </ul>

      <div class="actions">
        <button onclick={() => onDecide(proposal.requestId, [])}>Reject all</button>
        <button class="primary" onclick={() => onDecide(proposal.requestId, acceptedIds)}>
          Apply {acceptedIds.length}
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
    max-width: min(48rem, 92vw);
    min-width: min(32rem, 90vw);
    padding: 1rem;
    gap: 0.5rem;
    background: var(--bg-panel);
    color: var(--fg);
    border: 1px solid var(--bg-raise);
    border-radius: 6px;
  }
  h2 { margin: 0; font-size: 1.05rem; }
  .count, .reason { margin: 0; color: var(--fg-dim); }
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
  .rows li { padding: 0.1rem 0; }
  .rows label { display: flex; gap: 0.5rem; align-items: baseline; cursor: pointer; }
  .group { margin: 0.4rem 0 0.1rem; font-size: 0.9rem; color: var(--fg-dim); flex: 0 0 auto; }
  .warn { margin: 0; color: var(--fg-warn, #d08000); flex: 0 0 auto; }
  .cellname { min-width: 8rem; }
  .phys { font-variant-numeric: tabular-nums; }
  .raw, .flag { color: var(--fg-dim); font-size: 0.85em; }
  .err { color: var(--fg-error, #c04040); }
  li.stale { opacity: 0.75; }
  .actions, .actions-top { display: flex; gap: 0.5rem; justify-content: flex-end; flex: 0 0 auto; }
  .primary { font-weight: 600; }
</style>
