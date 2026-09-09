<!-- apps/desktop/src/components/MapPropertiesDialog.svelte -->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { AxisDef, AxisLibEntry, MapDef, Scaling } from '@binanalyzer/core';
  import { readAxisValues } from '@binanalyzer/core';
  import { buildPoolIndex, classifyRegions, DEFAULT_SCAN_CONFIG, poolAnchors, scanPrefixedAxes, type PoolAnchor, type PrefixedAxis } from '@binanalyzer/engine';
  import * as actions from '../store/actions.js';
  import { axisLibrary, maps, workingBytes } from '../store/stores.js';
  import { axisIdentityChanged, axisIdentityKey, detachedAxis, slotCount, stampAxis } from '../lib/axislib.js';
  import AxisPickerDialog from './AxisPickerDialog.svelte';
  import LayoutReview from './LayoutReview.svelte';

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

  // Seed staged edits once; live axis changes must not reset these fields.
  const initial = untrack(() => map);
  let name = $state(initial.name);
  let category = $state(initial.category ?? '');
  let units = $state(initial.scaling.units);
  let factor = $state(String(initial.scaling.factor));
  let offset = $state(String(initial.scaling.offset));
  let digits = $state(String(initial.scaling.digits));

  // Axis operations apply IMMEDIATELY via setMapAxis (each validated + toasted);
  // name/category/scaling stay staged on Save as before. Read the live map from
  // the store so the axis section reflects applied changes; the prop is a snapshot.
  const live = $derived($maps.find((m) => m.id === map.id) ?? map);
  const SLOTS: Array<'x' | 'y'> = ['x', 'y'];

  let picking: 'x' | 'y' | null = $state(null);
  let reviewing = $state(false);
  let reviewingLayout = $state(false);
  let pairs: PoolAnchor[] = $state([]);
  let chosenPair = $state('');
  const candidatePair = $derived(chosenPair === '' ? undefined : pairs[Number(chosenPair)]);
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

  const poolAxis = (p: PrefixedAxis): AxisDef => ({ kind: 'referenced', address: p.address, count: p.count, format: p.format });
  const pairAxisLabel = (p: PrefixedAxis): string =>
    `0x${p.address.toString(16).toUpperCase()} (${p.format.width * 8}-bit ${p.format.endianness === 'little' ? 'LE' : 'BE'})`;
  const rawValues = (axis: AxisDef | undefined): string =>
    axis && $workingBytes ? readAxisValues($workingBytes, axis).join(', ') : '(none)';

  function reviewAxes(): void {
    if (!$workingBytes) return;
    const cfg = DEFAULT_SCAN_CONFIG;
    const pool = scanPrefixedAxes($workingBytes, classifyRegions($workingBytes, cfg), cfg);
    pairs = [...poolAnchors({ address: live.address, rows: slotCount(live, 'y'), cols: slotCount(live, 'x') }, buildPoolIndex(pool), cfg)]
      .sort((a, b) => Math.max(b.x.end, b.y.end) - Math.max(a.x.end, a.y.end));
    chosenPair = '';
    reviewing = true;
  }

  function applyPair(): void {
    if (!candidatePair) return;
    const preserve = (p: PrefixedAxis, previous: AxisDef | undefined): AxisDef => {
      const next = poolAxis(p);
      return previous && axisIdentityKey(previous) === axisIdentityKey(next) ? previous : next;
    };
    const r = actions.setMapAxes(live.id, {
      xAxis: preserve(candidatePair.x, live.xAxis),
      yAxis: preserve(candidatePair.y, live.yAxis),
    });
    if (!r.ok) actions.pushToast('error', r.error);
    else {
      reviewing = false;
      actions.pushToast('info', 'Axis pair applied; undo restores both axes');
    }
  }

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
    <h3>Map properties — 0x{live.address.toString(16).toUpperCase()} · {live.rows}×{live.cols}</h3>
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
    {#if live.rows > 1 && live.cols > 1 && live.states === undefined}
      <button onclick={() => { reviewing = false; reviewingLayout = true; }}>Review table layout…</button>
      {#if reviewingLayout && $workingBytes}
        <LayoutReview map={live} bytes={$workingBytes} onclose={() => (reviewingLayout = false)} />
      {/if}
      <button onclick={reviewAxes}>Review detected axes…</button>
      {#if reviewing}
        <fieldset>
          <legend>Detected axis pairs ({pairs.length})</legend>
          <p class="axdesc">Nearby axes can share the same cell counts. Compare their raw breakpoints before applying. X/Y refer to the definition, before the view's Swap X/Y.</p>
          <p class="axdesc">Current X: {describeAxis(live.xAxis)}</p>
          <p class="axvalues" aria-label="Current X values">{rawValues(live.xAxis)}</p>
          <p class="axdesc">Current Y: {describeAxis(live.yAxis)}</p>
          <p class="axvalues" aria-label="Current Y values">{rawValues(live.yAxis)}</p>
          {#if pairs.length === 0}
            <p class="axdesc">No nearby count-prefixed axis pairs fit this table. Use a definition or the axis library.</p>
          {:else}
            <label>Detected axis pair
              <select bind:value={chosenPair}>
                <option value="">Choose a pair to preview</option>
                {#each pairs as pair, i}
                  <option value={String(i)}>X {pairAxisLabel(pair.x)} · Y {pairAxisLabel(pair.y)}</option>
                {/each}
              </select>
            </label>
            {#if candidatePair}
              <p class="axdesc">Candidate X ({candidatePair.x.count} cells)</p>
              <p class="axvalues" aria-label="Candidate X values">{rawValues(poolAxis(candidatePair.x))}</p>
              <p class="axdesc">Candidate Y ({candidatePair.y.count} cells)</p>
              <p class="axvalues" aria-label="Candidate Y values">{rawValues(poolAxis(candidatePair.y))}</p>
            {/if}
            <p class="axdesc">Apply updates both axes immediately without changing BIN values. Unchanged axes keep their names and scaling.</p>
            <button disabled={!candidatePair} onclick={applyPair}>Apply axis pair</button>
          {/if}
        </fieldset>
      {/if}
    {/if}
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
    max-width: calc(100vw - 48px);
    max-height: calc(100vh - 64px);
    overflow-y: auto;
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
  .axvalues { font-size: 12px; margin: 0; overflow-wrap: anywhere; }
  select { min-width: 0; max-width: 100%; }
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
