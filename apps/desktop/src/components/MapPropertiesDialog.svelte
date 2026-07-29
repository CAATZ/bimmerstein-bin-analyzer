<!-- apps/desktop/src/components/MapPropertiesDialog.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { MapDef, Scaling } from '@binanalyzer/core';
  import * as actions from '../store/actions.js';

  interface Props {
    map: MapDef;
    onclose: () => void;
  }
  const { map, onclose }: Props = $props();

  // Suspend the global keymap (T/K etc.) while this dialog is open.
  onMount(() => {
    actions.pushModal();
    return () => actions.popModal();
  });

  let name = $state(map.name);
  let category = $state(map.category ?? '');
  let units = $state(map.scaling.units);
  let factor = $state(String(map.scaling.factor));
  let offset = $state(String(map.scaling.offset));
  let digits = $state(String(map.scaling.digits));

  function save(): void {
    const f = Number(factor);
    const o = Number(offset);
    const d = Number(digits);
    if (!Number.isFinite(f) || !Number.isFinite(o) || !Number.isFinite(d) || d < 0) {
      actions.pushToast('error', 'factor/offset/digits must be numbers (digits ≥ 0)');
      return;
    }
    // Preserve an imported non-affine expression (spec §3: never silently
    // mis-scale — toPhysical returns raw while rawExpression is set). This
    // matches the dialog's own on-screen note; exactOptionalPropertyTypes:
    // add the key only when it exists.
    const scaling: Scaling = { factor: f, offset: o, units, digits: Math.trunc(d) };
    if (map.scaling.rawExpression !== undefined) scaling.rawExpression = map.scaling.rawExpression;
    const r = actions.updateMapMeta(map.id, { name, category, scaling });
    if (!r.ok) {
      actions.pushToast('error', r.error);
      return;
    }
    onclose();
  }
</script>

<div class="overlay" role="dialog" aria-label="Map properties">
  <div class="dialog">
    <h3>Map properties — 0x{map.address.toString(16).toUpperCase()} · {map.rows}×{map.cols}</h3>
    <label>Name <input bind:value={name} /></label>
    <label>Category <input bind:value={category} placeholder="(none)" /></label>
    <fieldset>
      <legend>Scaling (physical = raw × factor + offset)</legend>
      <label>factor <input bind:value={factor} /></label>
      <label>offset <input bind:value={offset} /></label>
      <label>units <input bind:value={units} /></label>
      <label>digits <input bind:value={digits} /></label>
      {#if map.scaling.rawExpression !== undefined}
        <p class="raw">Imported non-affine expression "{map.scaling.rawExpression}" is preserved; editing factor/offset here does not remove it.</p>
      {/if}
    </fieldset>
    <div class="row">
      <button onclick={onclose}>Cancel</button>
      <button onclick={save}>Save</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 55%);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .dialog {
    background: var(--bg-panel);
    border: 1px solid #3a3f48;
    border-radius: 8px;
    padding: 16px;
    width: 380px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    color: var(--fg-dim);
  }
  input {
    width: 220px;
  }
  fieldset {
    border: 1px solid #3a3f48;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .raw {
    color: var(--warn);
    font-size: 12px;
    margin: 0;
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
