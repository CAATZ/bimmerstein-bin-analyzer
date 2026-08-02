<!-- apps/desktop/src/components/ProposalPanel.svelte -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { popModal, pushModal } from '../store/actions.js';
  import { proposals, type ProposedChange } from '../store/stores.js';

  let { onDecide }: { onDecide: (requestId: string, acceptedIds: string[]) => void } = $props();

  const proposal = $derived($proposals[0]);
  let checked = $state<Record<string, boolean>>({});
  let trapped = false;

  // A fresh proposal starts with everything checked: the common case on a
  // 306-map import is "accept it all", and unchecking a few is far less work
  // than checking 306.
  $effect(() => {
    const p = $proposals[0];
    checked = p === undefined ? {} : Object.fromEntries(p.changes.map((c) => [c.id, true]));
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
      <p class="count">{proposal.changes.length} proposed changes — {acceptedIds.length} selected</p>

      <div class="actions-top">
        <button onclick={() => setAll(true)}>Select all</button>
        <button onclick={() => setAll(false)}>Select none</button>
      </div>

      <!-- Scrolls in ITS OWN container. At 306 rows a flex child with
           overflow:visible defeats the panel's max-height and pushes the
           buttons off-screen — exactly how the Axis Library attach dialog
           broke at 216 rows (2026-07-30). -->
      <ul class="rows">
        {#each proposal.changes as change (change.id)}
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
  .actions, .actions-top { display: flex; gap: 0.5rem; justify-content: flex-end; flex: 0 0 auto; }
  .primary { font-weight: 600; }
</style>
