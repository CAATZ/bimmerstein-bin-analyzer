<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { readGrid, sha256Hex, type MapDef } from '@binanalyzer/core';
  import { mapWithLayout, type LayoutCandidate, type LayoutReviewResult, type TableLayout } from '../lib/layoutreview.js';
  import { bin, workingBytes } from '../store/stores.js';
  import * as actions from '../store/actions.js';

  const { map, bytes, onclose }: { map: MapDef; bytes: Uint8Array; onclose: () => void } = $props();
  const initial = untrack(() => map);
  const snapshot = untrack(() => bytes.slice());
  const sourceBin = get(bin);
  const sourceHash = sha256Hex(snapshot);
  let loading = $state(true);
  let error = $state('');
  let candidates: LayoutCandidate[] = $state([]);
  let choice = $state('');
  let rows = $state(''), cols = $state(''), format = $state('');
  const formatKey = (m: TableLayout): string => `${m.format.width}-${m.format.endianness}`;
  const label = (m: TableLayout): string =>
    `0x${m.address.toString(16).toUpperCase()} · ${m.rows}×${m.cols} · ${m.format.width * 8}-bit ${m.format.signed ? 'signed' : 'unsigned'}${m.format.width > 1 ? (m.format.endianness === 'little' ? ' LE' : ' BE') : ''}`;
  const filtered = $derived(candidates.map((item, i) => ({ item, key: String(i) })).filter(({ item }) =>
    (rows === '' || item.rows === Number(rows)) && (cols === '' || item.cols === Number(cols)) &&
    (format === '' || formatKey(item) === format)));
  const candidate = $derived(filtered.find(c => c.key === choice)?.item);
  const preview = $derived(candidate ? mapWithLayout(map, candidate, snapshot.length) : undefined);
  const rawGrid = (m: MapDef): string => readGrid(snapshot, m).map(row => row.map(v => String(v).padStart(6)).join(' ')).join('\n');

  onMount(() => {
    const worker = new Worker(new URL('../worker/layout.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<LayoutReviewResult>) => {
      loading = false;
      if ('error' in data) error = data.error;
      else candidates = data.candidates;
      worker.terminate();
    };
    worker.onerror = () => { loading = false; error = 'Layout review failed. Close and try again.'; worker.terminate(); };
    worker.postMessage({ bytes: snapshot, map: initial });
    return () => worker.terminate();
  });

  function apply(): void {
    if (!candidate) return;
    const current = get(workingBytes);
    if (get(bin) !== sourceBin || !current || sha256Hex(current) !== sourceHash) {
      error = 'BIN values changed. Close and reopen layout review.';
      return;
    }
    const result = actions.setMapLayout(map.id, candidate);
    if (!result.ok) { error = result.error; return; }
    actions.pushToast('info', 'Table layout applied; undo restores the definition');
    onclose();
  }
</script>

<fieldset aria-label="Table layout review">
  <legend>Review table layout</legend>
  <p>Compare raw values before applying. These layouts come from byte patterns; they do not confirm how firmware reads a table.</p>
  <p>Current: {label(map)}</p>
  <pre aria-label="Current table values">{rawGrid(map)}</pre>
  {#if loading}
    <p role="status">Finding alternative layouts…</p>
  {:else if candidates.length === 0}
    <p>No alternative layouts found within the scanner's supported sizes and data regions.</p>
  {:else}
    <div class="filters">
      <label>Rows <input aria-label="Layout rows" bind:value={rows} inputmode="numeric" placeholder="Any" /></label>
      <label>Columns <input aria-label="Layout columns" bind:value={cols} inputmode="numeric" placeholder="Any" /></label>
      <label>Format
        <select aria-label="Layout format" bind:value={format}>
          <option value="">Any</option><option value="1-big">8-bit unsigned</option>
          <option value="2-little">16-bit unsigned LE</option><option value="2-big">16-bit unsigned BE</option>
        </select>
      </label>
    </div>
    <label>Candidate layout ({filtered.length})
      <select aria-label="Candidate layout" bind:value={choice}>
        <option value="">Choose a layout to preview</option>
        {#each filtered as { item, key }}<option value={key}>{label(item)}</option>{/each}
      </select>
    </label>
    {#if candidate && preview?.ok}
      <p>Candidate: {label(candidate)} · start offset {candidate.address - map.address} bytes</p>
      <pre aria-label="Candidate table values">{rawGrid(preview.value)}</pre>
      <p aria-label="Layout evidence">Surface smoothness: {candidate.score.toFixed(3)} (0–1). Top boundary: {candidate.topEdge ? 'passes' : 'below threshold'}; bottom boundary: {candidate.bottomEdge ? 'passes' : 'below threshold'}. Nearby axis pairs fitting this shape: {candidate.axisPairs}.</p>
      {#each ['xAxis', 'yAxis'] as slot}
        {#if map[slot as 'xAxis' | 'yAxis'] && !preview.value[slot as 'xAxis' | 'yAxis']}
          <p class="notice">{slot === 'xAxis' ? 'X' : 'Y'} axis will be removed because its count does not fit. Use axis review or a definition to assign a replacement.</p>
        {/if}
      {/each}
      <p>Apply changes the definition to row-major storage. Compatible axes, names and scaling are retained. BIN bytes and existing edits stay unchanged.</p>
      <button onclick={apply}>Apply table layout</button>
    {:else if preview && !preview.ok}
      <p role="alert">{preview.error}</p>
    {/if}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <button onclick={onclose}>{loading ? 'Cancel layout review' : 'Close layout review'}</button>
</fieldset>

<style>
  fieldset { min-width: 0; border: 1px solid #3a3f48; border-radius: 6px; display: flex; flex-direction: column; gap: 8px; }
  p { font-size: 12px; margin: 0; color: var(--fg-dim); }
  pre { max-height: 180px; overflow: auto; margin: 0; font-size: 12px; background: var(--bg-panel); }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; min-width: 0; }
  select { width: 100%; min-width: 0; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; }
  .filters input { width: 60px; }
  .notice, [role='alert'] { color: var(--warn); }
</style>
