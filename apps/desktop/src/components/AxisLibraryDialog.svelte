<!-- apps/desktop/src/components/AxisLibraryDialog.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import type { AxisDef, AxisLibEntry } from '@binanalyzer/core';
  import { DEFAULT_SCAN_CONFIG, saToFo, scanPrefixedAxes, type PrefixedAxis } from '@binanalyzer/engine';
  import { axisLibrary, bin, maps, potentialMaps } from '../store/stores.js';
  import * as actions from '../store/actions.js';
  import { attachTargets, axisIdentityKey, fanOutCount, stampAxis, type AttachTarget } from '../lib/axislib.js';
  import { axisSaRepresentable, isMs41FullRead } from '../lib/defframe.js';

  interface Props {
    onclose: () => void;
  }
  const { onclose }: Props = $props();

  // Suspend the global keymap while this dialog is open, and run the detected-
  // axis sweep ONCE per open: exported engine scanPrefixedAxes on the main
  // thread (lib/snap.ts precedent — single bounded pass) over a SYNTHETIC
  // full-range data region, because the regions store is empty after a
  // project load.
  let pool: PrefixedAxis[] = $state([]);
  onMount(() => {
    actions.pushModal();
    const image = get(bin);
    if (image) {
      pool = scanPrefixedAxes(image.bytes, [{ start: 0, end: image.size, kind: 'data' }], DEFAULT_SCAN_CONFIG);
    }
    return () => actions.popModal();
  });

  const poolAxis = (p: PrefixedAxis): AxisDef => ({ kind: 'referenced', address: p.address, count: p.count, format: p.format });
  const freshDetected = $derived.by(() => {
    const inLib = new Set($axisLibrary.map((e) => axisIdentityKey(e.axis)).filter((k): k is string => k !== undefined));
    return pool.filter((p) => !inLib.has(axisIdentityKey(poolAxis(p)) ?? ''));
  });
  const DETECTED_SHOWN = 200;

  const fullRead = $derived($bin !== null && isMs41FullRead($bin.size));

  // ---- create / edit form ----
  let formOpen = $state(false);
  let editId: string | null = $state(null);
  let fName = $state('');
  let fAddress = $state('');
  let fAddressIsSa = $state(false);
  let fCount = $state('8');
  let fWidth = $state('1');
  let fSigned = $state(false);
  let fEndian: 'little' | 'big' = $state('little');
  let fFactor = $state('1');
  let fOffset = $state('0');
  let fUnits = $state('');
  let fDigits = $state('0');
  let fNotes = $state('');

  function openCreate(prefill?: PrefixedAxis): void {
    editId = null;
    fName = '';
    fAddress = prefill ? `0x${prefill.address.toString(16)}` : '';
    fAddressIsSa = false;
    fCount = String(prefill?.count ?? 8);
    fWidth = String(prefill?.format.width ?? 1);
    fSigned = prefill?.format.signed ?? false;
    fEndian = prefill?.format.endianness ?? 'little';
    fFactor = '1';
    fOffset = '0';
    fUnits = '';
    fDigits = '0';
    fNotes = '';
    formOpen = true;
  }

  function openEdit(e: AxisLibEntry): void {
    editId = e.id;
    fName = e.name;
    fAddress = e.axis.address !== undefined ? `0x${e.axis.address.toString(16)}` : '';
    fAddressIsSa = false;
    fCount = String(e.axis.count);
    fWidth = String(e.axis.format?.width ?? 1);
    fSigned = e.axis.format?.signed ?? false;
    fEndian = e.axis.format?.endianness ?? 'little';
    fFactor = String(e.axis.scaling?.factor ?? 1);
    fOffset = String(e.axis.scaling?.offset ?? 0);
    fUnits = e.axis.scaling?.units ?? '';
    fDigits = String(e.axis.scaling?.digits ?? 0);
    fNotes = e.notes ?? '';
    formOpen = true;
  }

  // D3: entry edits never silently re-stamp — an explicit confirmation follows.
  let pendingRestamp: { id: string; count: number } | null = $state(null);

  function submitForm(): void {
    const rawAddr = Number(fAddress);
    const count = Number(fCount);
    const width = Number(fWidth);
    const f = Number(fFactor);
    const o = Number(fOffset);
    const d = Number(fDigits);
    if (
      fAddress.trim() === '' || // Number('') is 0 — a blank field must not silently become address 0x0
      !Number.isInteger(rawAddr) || rawAddr < 0 || !Number.isInteger(count) || count < 1 ||
      (width !== 1 && width !== 2 && width !== 4) ||
      !Number.isFinite(f) || !Number.isFinite(o) || !Number.isInteger(d) || d < 0
    ) {
      actions.pushToast('error', 'address is required; address/count must be non-negative integers, width 1|2|4, factor/offset numbers, digits ≥ 0');
      return;
    }
    const address = fAddressIsSa ? saToFo(rawAddr) : rawAddr;
    const axis: AxisDef = {
      kind: 'referenced',
      address,
      count,
      format: { width: width as 1 | 2 | 4, signed: fSigned, endianness: fEndian },
      scaling: { factor: f, offset: o, units: fUnits, digits: d },
    };
    const r = editId === null
      ? actions.addAxisLibEntry(fName, axis, fNotes)
      : actions.updateAxisLibEntry(editId, { name: fName, axis, notes: fNotes });
    if (!r.ok) {
      actions.pushToast('error', r.error);
      return;
    }
    if (editId !== null) {
      const n = fanOutCount(editId, get(maps));
      if (n > 0) pendingRestamp = { id: editId, count: n };
    }
    formOpen = false;
  }

  function doRestamp(): void {
    if (pendingRestamp === null) return;
    const res = actions.restampAxisLibEntry(pendingRestamp.id);
    if (res.skipped.length > 0) {
      actions.pushToast('error', `${res.updated} map slot(s) re-stamped; ${res.skipped.length} skipped: ${res.skipped[0] ?? ''}`);
    } else {
      actions.pushToast('info', `${res.updated} attached map slot(s) updated`);
    }
    pendingRestamp = null;
  }

  // ---- attach flow ----
  let attaching: AxisLibEntry | null = $state(null);
  let targets: AttachTarget[] = $state([]);
  let checked: boolean[] = $state([]);

  function openAttach(e: AxisLibEntry): void {
    attaching = e;
    targets = attachTargets(e, $maps, $potentialMaps).filter((t) => !t.attached);
    checked = targets.map((t) => t.suggested);
  }

  function doAttach(): void {
    if (attaching === null) return;
    const entry = attaching;
    let stamped = 0;
    const failed: string[] = [];
    const promoted = new Set<string>();
    targets.forEach((t, i) => {
      if (!checked[i]) return;
      if (t.potential && !promoted.has(t.map.id)) {
        if (actions.promoteMap(t.map.id)) promoted.add(t.map.id);
        else {
          failed.push(`${t.map.name}: promote failed`);
          return;
        }
      }
      const r = actions.setMapAxis(t.map.id, t.slot, stampAxis(entry));
      if (r.ok) stamped++;
      else failed.push(`${t.map.name} ${t.slot}: ${r.error}`);
    });
    actions.pushToast(
      failed.length > 0 ? 'error' : 'info',
      failed.length > 0
        ? `Attached ${stamped}; ${failed.length} failed: ${failed[0] ?? ''}`
        : `Attached "${entry.name}" to ${stamped} map slot(s)`
    );
    attaching = null;
  }

  function detachAll(e: AxisLibEntry): void {
    const { detached } = actions.detachAxisLibEntry(e.id);
    actions.pushToast('info', `Detached ${detached} map slot(s) from "${e.name}" (inline axes kept)`);
  }

  function removeEntry(e: AxisLibEntry): void {
    const { detached } = actions.removeAxisLibEntry(e.id);
    actions.pushToast('info', `Removed "${e.name}" (${detached} stamp(s) detached; inline axes kept)`);
  }

  let expanded: string | null = $state(null);
</script>

<div class="overlay" role="dialog" aria-label="Axis library">
  <div class="dialog">
    <h3>Axis library ({$axisLibrary.length})</h3>
    <div class="body">
      <ul class="entries">
        {#each $axisLibrary as e (e.id)}
          {@const fan = fanOutCount(e.id, $maps)}
          <li>
            <div class="entryrow">
              <span class="ename">{e.name}</span>
              <span class="emeta">
                {e.axis.kind === 'referenced' && e.axis.address !== undefined ? `0x${e.axis.address.toString(16).toUpperCase()}` : 'literal'} ×{e.axis.count}{e.axis.format ? ` · ${e.axis.format.width * 8}-bit ${e.axis.format.signed ? 'signed' : 'unsigned'}${e.axis.format.width > 1 ? (e.axis.format.endianness === 'little' ? ' LE' : ' BE') : ''}` : ''}
              </span>
              {#if e.notes}
                <span class="badge notes" title={e.notes}>notes</span>
              {/if}
              <button class="link" onclick={() => (expanded = expanded === e.id ? null : e.id)}>attached to {fan}</button>
              {#if fullRead && !axisSaRepresentable(e.axis)}
                <span class="badge" title="No RomRaider representation on this full read; attached maps will be excluded from RomRaider export">no RR</span>
              {/if}
              <button onclick={() => openAttach(e)}>Attach…</button>
              <button onclick={() => openEdit(e)} disabled={e.axis.kind === 'literal'} title="v1 editor is referenced-only; literal entries are created via 'Save to library'">Edit</button>
              <button onclick={() => detachAll(e)} disabled={fan === 0}>Detach all</button>
              <button onclick={() => removeEntry(e)}>Remove</button>
            </div>
            {#if expanded === e.id}
              <ul class="sharers">
                {#each $maps.filter((m) => m.xAxis?.libId === e.id || m.yAxis?.libId === e.id) as m (m.id)}
                  <li><button class="link" onclick={() => actions.selectMap(m)}>{m.name}</button></li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
        {#if $axisLibrary.length === 0}
          <li class="empty">No axes defined yet — create one below, use a detected axis, or "Save as axis" on a 1D curve.</li>
        {/if}
      </ul>
      <div class="row wrap">
        <button onclick={() => openCreate()}>New axis…</button>
      </div>
      <h4>
        Detected count-prefixed axes ({freshDetected.length}{freshDetected.length > DETECTED_SHOWN ? `, showing first ${DETECTED_SHOWN}` : ''})
      </h4>
      <ul class="detected">
        {#each freshDetected.slice(0, DETECTED_SHOWN) as p (`${p.address}:${p.count}:${p.format.width}:${p.format.endianness}`)}
          <li>
            <span>0x{p.address.toString(16).toUpperCase()} ×{p.count} · {p.format.width * 8}-bit</span>
            <button onclick={() => openCreate(p)}>Add to library…</button>
          </li>
        {/each}
      </ul>
    </div>
    <div class="row">
      <button onclick={onclose}>Close</button>
    </div>
  </div>
</div>

{#if formOpen}
  <div class="overlay inner" role="dialog" aria-label={editId === null ? 'New axis' : 'Edit axis'}>
    <div class="dialog narrow">
      <h3>{editId === null ? 'New axis' : 'Edit axis'}</h3>
      <label>Name <input bind:value={fName} /></label>
      <label>Address <input bind:value={fAddress} placeholder="0x…" /></label>
      {#if fullRead}
        <label class="sa">
          <input type="checkbox" bind:checked={fAddressIsSa} />
          address is a RomRaider storageaddress (convert to file offset)
        </label>
      {/if}
      <label>Count <input bind:value={fCount} /></label>
      <label>width
        <select bind:value={fWidth}>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="4">4</option>
        </select>
      </label>
      <label><input type="checkbox" bind:checked={fSigned} /> signed</label>
      <label>endian
        <select bind:value={fEndian}>
          <option value="little">LoHi (LE)</option>
          <option value="big">HiLo (BE)</option>
        </select>
      </label>
      <fieldset>
        <legend>Scaling (physical = raw × factor + offset)</legend>
        <label>factor <input bind:value={fFactor} /></label>
        <label>offset <input bind:value={fOffset} /></label>
        <label>units <input bind:value={fUnits} /></label>
        <label>digits <input bind:value={fDigits} /></label>
      </fieldset>
      <label>Notes <input bind:value={fNotes} /></label>
      <div class="row">
        <button onclick={() => (formOpen = false)}>Cancel</button>
        <button onclick={submitForm}>{editId === null ? 'Create' : 'Save'}</button>
      </div>
    </div>
  </div>
{/if}

{#if pendingRestamp !== null}
  <div class="overlay inner" role="dialog" aria-label="Update attached maps">
    <div class="dialog narrow">
      <h3>Update {pendingRestamp.count} attached map slot(s)?</h3>
      <p class="hint">The entry changed. Attached maps keep their old stamps until updated; misfits are skipped and reported.</p>
      <div class="row">
        <button onclick={() => (pendingRestamp = null)}>Keep old stamps</button>
        <button onclick={doRestamp}>Update {pendingRestamp.count} slot(s)</button>
      </div>
    </div>
  </div>
{/if}

{#if attaching !== null}
  <div class="overlay inner" role="dialog" aria-label="Attach axis to maps">
    <div class="dialog">
      <h3>Attach "{attaching.name}" — {targets.length} fitting slot(s)</h3>
      <!-- spec §6: warn at attach time, never 19-maps-late at export -->
      {#if fullRead && !axisSaRepresentable(attaching.axis)}
        <p class="badgewarn">
          This axis has no RomRaider representation on this full read — maps attached to it will be
          excluded from RomRaider export.
        </p>
      {/if}
      <ul class="targets">
        {#each targets as t, i (`${t.map.id}:${t.slot}`)}
          <li>
            <label>
              <input type="checkbox" bind:checked={checked[i]} />
              {t.map.name} — {t.slot.toUpperCase()} axis
              {#if t.potential}<span class="note">(will be confirmed)</span>{/if}
              {#if t.suggested && t.scalingDiffers}<span class="note">(scaling will be unified on attach)</span>{/if}
            </label>
          </li>
        {/each}
        {#if targets.length === 0}
          <li class="empty">No maps have a slot with {attaching.axis.count} cells.</li>
        {/if}
      </ul>
      <div class="row">
        <button onclick={() => (attaching = null)}>Cancel</button>
        <button onclick={doAttach} disabled={!checked.some(Boolean)}>Attach</button>
      </div>
    </div>
  </div>
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
  .overlay.inner {
    z-index: 60;
  }
  .dialog {
    background: var(--bg-panel);
    border: 1px solid #3a3f48;
    border-radius: 8px;
    padding: 16px;
    width: 640px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dialog.narrow {
    width: 400px;
  }
  .body {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .entryrow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ename {
    font-weight: 600;
    min-width: 120px;
  }
  .emeta,
  .note,
  .hint,
  .empty {
    color: var(--fg-dim);
    font-size: 12px;
  }
  .badge {
    color: var(--warn);
    border: 1px solid var(--warn);
    border-radius: 4px;
    padding: 0 4px;
    font-size: 11px;
  }
  .badgewarn {
    color: var(--warn);
    font-size: 12px;
    margin: 0;
  }
  .badge.notes {
    color: var(--fg-dim);
    border-color: #3a3f48;
  }
  .link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
    font-size: 12px;
  }
  .sharers {
    margin-left: 16px;
  }
  .detected li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    color: var(--fg-dim);
  }
  input:not([type='checkbox']) {
    width: 200px;
  }
  fieldset {
    border: 1px solid #3a3f48;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .row.wrap {
    justify-content: flex-start;
  }
  h4 {
    margin: 8px 0 0;
  }
  /* The attach sub-dialog has no .body wrapper, so this list IS its scroll
     container. Without overflow the list's flex min-height:auto resolves to the
     full content height (216 fitting slots on a real MS41 bin), the dialog
     blows past max-height:80vh, and the Cancel/Attach row is pushed off-screen
     — leaving the modal impossible to submit OR dismiss. */
  .targets {
    overflow-y: auto;
  }
  .targets label {
    justify-content: flex-start;
  }
</style>
