<!-- apps/desktop/src/components/Toasts.svelte -->
<script lang="ts">
  import { toasts } from '../store/stores.js';
  import { dismissToast } from '../store/actions.js';

  const AUTO_DISMISS_MS = 6000;
  // Timers are component concerns (store stays timer-free). Each toast id is
  // scheduled once; dismissing an already-dismissed id is a harmless filter.
  const scheduled = new Set<number>();
  $effect(() => {
    for (const t of $toasts) {
      if (scheduled.has(t.id)) continue;
      scheduled.add(t.id);
      setTimeout(() => dismissToast(t.id), AUTO_DISMISS_MS);
    }
  });
</script>

<div class="toasts">
  {#each $toasts as t (t.id)}
    <div class="toast {t.kind}">
      <span>{t.text}</span>
      <button onclick={() => dismissToast(t.id)} title="Dismiss">×</button>
    </div>
  {/each}
</div>
