<!-- apps/desktop/src/components/MapPropertiesDialog.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { AxisDef, AxisLibEntry, MapDef, Scaling } from '@binanalyzer/core';
  import * as actions from '../store/actions.js';
  import { axisLibrary, maps } from '../store/stores.js';
  import { axisIdentityChanged, detachedAxis, slotCount, stampAxis } from '../lib/axislib.js';
  import AxisPickerDialog from './AxisPickerDialog.svelte';

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

  // Axis operations apply IMMEDIATELY via setMapAxis (each validated + toasted);
  // name/category/scaling stay staged on Save as before. Read the live map from
  // the store so the axis section reflects applied changes; the prop is a snapshot.
  const live = $derived($maps.find((m) => m.id === map.id) ?? map);
  const SLOTS: Array<'x' | 'y'> = ['x', 'y'];

  let picking: 'x' | 'y' | null = $state(null);
  let editingSlot: 'x' | 'y' | null = $state(null);
  let axAddress = $state('');
  let axCount = $state('');
  let axWidth = $state('1');
  let axSigned = $state(false);
  let axEndian: 'little' | 'big' = $state('little');
  let axName = $state('');
  let axFactor = $state('1');
  let axOffset = $state('0');
  let axUnits = $state('');
  let axDigits = $state('0');

  const slotAxis = (slot: 'x' | 'y'): AxisDef | undefined => (slot === 'x' ? live.xAxis : live.yAxis);

  function describeAxis(ax: AxisDef | undefined): string {
    if (!ax) return '(none)';
    const nm = ax.name !== undefined ? `${ax.name} — ` : '';
    const lib = ax.libId !== undefined ? ' · library' : '';
    if (ax.kind === 'referenced') {
      const f = ax.format;
      const fmtTxt = f ? `${f.width * 8}-bit ${f.signed ? 'signed' : 'unsigned'}${f.width > 1 ? (f.endianness === 'little' ? ' LE' : ' BE') : ''}` : '?';
      return `${nm}0x${(ax.address ?? 0).toString(16).toUpperCase()} ×${ax.count} · ${fmtTxt}${lib}`;
    }
    if (ax.kind === 'literal') return `${nm}literal ×${ax.count}${lib}`;
    return `${nm}index ×${ax.count}`;
  }

  function saveToLibrary(slot: 'x' | 'y'): void {
    const ax = slotAxis(slot);
    if (!ax || ax.kind === 'index') {
      actions.pushToast('error', 'No referenced/literal axis in this slot to save');
      return;
    }
    const fallback = `Axis 0x${(ax.address ?? 0).toString(16).toUpperCase()} ×${ax.count}`;
    const r = actions.addAxisLibEntry(ax.name ?? fallback, ax);
    if (!r.ok) {
      actions.pushToast('error', r.error);
      return;
    }
    const s = actions.setMapAxis(live.id, slot, stampAxis(r.value));
    if (!s.ok) {
      actions.pushToast('error', s.error);
      return;
    }
    actions.pushToast('info', `Saved "${r.value.name}" to the axis library`);
  }

  function pickEntries(slot: 'x' | 'y'): AxisLibEntry[] {
    return $axisLibrary.filter((e) => e.axis.count === slotCount(live, slot));
  }

  function attachPicked(slot: 'x' | 'y', entry: AxisLibEntry): void {
    const r = actions.setMapAxis(live.id, slot, stampAxis(entry));
    if (!r.ok) actions.pushToast('error', r.error);
    picking = null;
  }

  function detach(slot: 'x' | 'y'): void {
    const ax = slotAxis(slot);
    if (!ax) return;
    const r = actions.setMapAxis(live.id, slot, detachedAxis(ax));
    if (!r.ok) actions.pushToast('error', r.error);
  }

  function removeAxis(slot: 'x' | 'y'): void {
    const r = actions.setMapAxis(live.id, slot, undefined);
    if (!r.ok) actions.pushToast('error', r.error);
  }

  function beginEdit(slot: 'x' | 'y'): void {
    const ax = slotAxis(slot);
    editingSlot = slot;
    axAddress = ax?.address !== undefined ? `0x${ax.address.toString(16)}` : '';
    axCount = String(ax?.count ?? slotCount(live, slot));
    axWidth = String(ax?.format?.width ?? 1);
    axSigned = ax?.format?.signed ?? false;
    axEndian = ax?.format?.endianness ?? 'little';
    axName = ax?.name ?? '';
    axFactor = String(ax?.scaling?.factor ?? 1);
    axOffset = String(ax?.scaling?.offset ?? 0);
    axUnits = ax?.scaling?.units ?? '';
    axDigits = String(ax?.scaling?.digits ?? 0);
  }

  function saveLocalEdit(): void {
    if (editingSlot === null) return;
    const slot = editingSlot;
    const prev = slotAxis(slot);
    const address = Number(axAddress);
    const count = Number(axCount);
    const width = Number(axWidth);
    const f = Number(axFactor);
    const o = Number(axOffset);
    const d = Number(axDigits);
    if (
      axAddress.trim() === '' || // Number('') is 0 — a blank field must not silently become address 0x0
      !Number.isInteger(address) || address < 0 || !Number.isInteger(count) || count < 1 ||
      (width !== 1 && width !== 2 && width !== 4) ||
      !Number.isFinite(f) || !Number.isFinite(o) || !Number.isInteger(d) || d < 0
    ) {
      actions.pushToast('error', 'address is required; address/count must be non-negative integers, width 1|2|4, factor/offset numbers, digits ≥ 0');
      return;
    }
    const next: AxisDef = {
      kind: 'referenced',
      address,
      count,
      format: { width: width as 1 | 2 | 4, signed: axSigned, endianness: axEndian },
      scaling: { factor: f, offset: o, units: axUnits, digits: d },
    };
    if (axName.trim() !== '') next.name = axName.trim();
    // D3: identity edits detach; a pure rename keeps the stamp.
    if (prev?.libId !== undefined && !axisIdentityChanged(prev, next)) next.libId = prev.libId;
    const r = actions.setMapAxis(live.id, slot, next);
    if (!r.ok) {
      actions.pushToast('error', r.error);
      return;
    }
    editingSlot = null;
  }

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
    {#each SLOTS as slot (slot)}
      <fieldset>
        <legend>{slot.toUpperCase()} axis</legend>
        <p class="axdesc">{describeAxis(slotAxis(slot))}</p>
        <div class="row wrap">
          <button onclick={() => saveToLibrary(slot)} disabled={slotAxis(slot) === undefined || slotAxis(slot)?.kind === 'index' || slotAxis(slot)?.libId !== undefined}>Save to library</button>
          <button onclick={() => (picking = slot)}>Pick from library…</button>
          <button onclick={() => detach(slot)} disabled={slotAxis(slot)?.libId === undefined}>Detach</button>
          <button onclick={() => beginEdit(slot)} disabled={slotAxis(slot)?.kind === 'literal'}>Edit locally…</button>
          <button onclick={() => removeAxis(slot)} disabled={slotAxis(slot) === undefined}>Remove</button>
        </div>
        {#if editingSlot === slot}
          <div class="axedit">
            <label>address <input bind:value={axAddress} placeholder="0x…" /></label>
            <label>count <input bind:value={axCount} /></label>
            <label>width
              <select bind:value={axWidth}>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="4">4</option>
              </select>
            </label>
            <label><input type="checkbox" bind:checked={axSigned} /> signed</label>
            <label>endian
              <select bind:value={axEndian}>
                <option value="little">LoHi (LE)</option>
                <option value="big">HiLo (BE)</option>
              </select>
            </label>
            <label>name <input bind:value={axName} /></label>
            <label>factor <input bind:value={axFactor} /></label>
            <label>offset <input bind:value={axOffset} /></label>
            <label>units <input bind:value={axUnits} /></label>
            <label>digits <input bind:value={axDigits} /></label>
            <div class="row">
              <button onclick={() => (editingSlot = null)}>Cancel</button>
              <button onclick={saveLocalEdit}>Apply</button>
            </div>
          </div>
        {/if}
      </fieldset>
    {/each}
    <div class="row">
      <button onclick={onclose}>Cancel</button>
      <button onclick={save}>Save</button>
    </div>
  </div>
</div>

{#if picking !== null}
  <AxisPickerDialog
    entries={pickEntries(picking)}
    onpick={(e) => attachPicked(picking!, e)}
    oncancel={() => (picking = null)}
  />
{/if}

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
    width: 460px;
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
  .axdesc {
    color: var(--fg-dim);
    font-size: 12px;
    margin: 0;
  }
  .row.wrap {
    flex-wrap: wrap;
    justify-content: flex-start;
  }
  .axedit {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid #3a3f48;
    padding-top: 6px;
  }
  .axedit input {
    width: 180px;
  }
</style>
