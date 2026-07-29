<!-- apps/desktop/src/views/HexdumpView.svelte -->
<script lang="ts">
  import type { ValueFormat } from '@binanalyzer/core';
  import { readValue } from '@binanalyzer/core';
  import { bin, maps, potentialMaps, regions, scrollRequest, selection, viewParams } from '../store/stores.js';
  import * as actions from '../store/actions.js';
  import {
    barFraction, bytesPerRow, cellAtPoint, cellOfOffset, chipsForRows, defaultRawRange,
    hexCell, offsetOfCell, regionKindAt, rowCount, rowOfOffset, visibleRows, type GridGeometry,
  } from '../lib/hexlayout.js';
  import { snapSelection } from '../lib/snap.js';

  const ROW_H = 20;
  const GUTTER_W = 88;
  const CELL_PAD = 10;
  const FONT = '12px Consolas, "Courier New", monospace';

  let scroller: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let viewportW = $state(0);
  let viewportH = $state(0);
  let scrollTop = $state(0);
  let dragAnchor: number | null = null;
  let cellWidth = 40; // measured during draw; used by hit-testing

  const geometry = $derived.by((): GridGeometry | null => {
    const image = $bin;
    if (!image) return null;
    return {
      origin: $viewParams.origin,
      columns: $viewParams.columns,
      width: $viewParams.format.width,
      totalBytes: image.size,
    };
  });
  const totalRows = $derived(geometry === null ? 0 : rowCount(geometry));
  /** Hex text always shows the bit pattern — strip float for the text read. */
  const intFormat = $derived.by((): ValueFormat => {
    const { float: _float, ...rest } = $viewParams.format;
    return rest;
  });

  function draw(): void {
    const g = geometry;
    const image = $bin;
    if (!canvas || !g || !image || viewportW <= 0 || viewportH <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.floor(viewportW * dpr);
    const pxH = Math.floor(viewportH * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewportW, viewportH);
    ctx.font = FONT;
    cellWidth = Math.ceil(ctx.measureText('0'.repeat(g.width * 2)).width) + CELL_PAD;
    const range = $viewParams.valueRange ?? defaultRawRange($viewParams.format);
    const { first, last } = visibleRows(scrollTop, viewportH, ROW_H, totalRows);
    const sel = $selection;
    const fmt = $viewParams.format;
    const txtFmt = intFormat;
    for (let row = first; row <= last; row++) {
      const y = row * ROW_H - scrollTop;
      ctx.fillStyle = '#9aa0a6';
      ctx.fillText(offsetOfCell(g, row, 0).toString(16).toUpperCase().padStart(6, '0'), 6, y + 14);
      for (let col = 0; col < g.columns; col++) {
        const off = offsetOfCell(g, row, col);
        if (off + g.width > image.size) break;
        const x = GUTTER_W + col * cellWidth;
        const raw = readValue(image.bytes, off, txtFmt);
        const value = fmt.float === true ? readValue(image.bytes, off, fmt) : raw;
        // value bar (bottom-anchored)
        const frac = barFraction(value, range);
        if (frac > 0) {
          const h = frac * (ROW_H - 4);
          ctx.fillStyle = 'rgba(76, 141, 255, 0.30)';
          ctx.fillRect(x + 1, y + (ROW_H - 2) - h, cellWidth - 4, h);
        }
        ctx.fillStyle = '#e8eaed';
        ctx.fillText(hexCell(raw, g.width), x + 3, y + 14);
        // engine region dimming (spec §7; absent regions = no dimming)
        const kind = regionKindAt($regions, off);
        if (kind === 'code') {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
          ctx.fillRect(x, y, cellWidth, ROW_H);
        } else if (kind === 'empty') {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
          ctx.fillRect(x, y, cellWidth, ROW_H);
        }
        if (sel !== null && off >= sel.start && off < sel.end) {
          ctx.fillStyle = 'rgba(255, 170, 0, 0.22)';
          ctx.fillRect(x, y, cellWidth, ROW_H);
        }
      }
    }
    // selection outline on the first selected cell (orientation anchor)
    if (sel !== null) {
      const anchorCell = cellOfOffset(g, sel.start); // null when before origin/past end
      if (anchorCell !== null && anchorCell.row >= first && anchorCell.row <= last) {
        ctx.strokeStyle = 'rgba(255, 170, 0, 0.9)';
        ctx.strokeRect(
          GUTTER_W + anchorCell.col * cellWidth + 0.5,
          anchorCell.row * ROW_H - scrollTop + 0.5,
          cellWidth - 1,
          ROW_H - 1
        );
      }
    }
    // map chips (confirmed solid, potential translucent)
    const chipSource = [
      ...$maps.map((m) => ({ id: m.id, name: m.name, address: m.address, potential: false })),
      ...$potentialMaps.map((m) => ({ id: m.id, name: m.name, address: m.address, potential: true })),
    ];
    for (const chip of chipsForRows(chipSource, g, first, last)) {
      const x = GUTTER_W + chip.col * cellWidth;
      const y = chip.row * ROW_H - scrollTop;
      const label = chip.name.length > 24 ? `${chip.name.slice(0, 23)}…` : chip.name;
      const w = ctx.measureText(label).width + 8;
      ctx.fillStyle = chip.potential ? 'rgba(122, 92, 255, 0.55)' : 'rgba(122, 92, 255, 0.95)';
      ctx.fillRect(x, y - 1, w, 13);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x + 4, y + 9);
    }
  }

  // One draw effect: reads every reactive input, redraws synchronously.
  $effect(() => {
    draw();
  });

  // Sidebar/F jumps (spec §7: instant, not animated).
  $effect(() => {
    const req = $scrollRequest;
    const g = geometry;
    if (req === null || g === null || !scroller) return;
    scroller.scrollTop = Math.max(0, rowOfOffset(g, req.offset) * ROW_H - viewportH / 3);
  });

  function offsetAt(e: MouseEvent): number | null {
    const g = geometry;
    if (!g) return null;
    const rect = scroller.getBoundingClientRect();
    const cell = cellAtPoint(
      g,
      { gutterWidth: GUTTER_W, cellWidth, rowHeight: ROW_H },
      e.clientX - rect.left,
      e.clientY - rect.top + scrollTop
    );
    if (cell === null) return null;
    const off = offsetOfCell(g, cell.row, cell.col);
    return off + g.width <= g.totalBytes ? off : null;
  }

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const off = offsetAt(e);
    const g = geometry;
    if (off === null || g === null) return;
    dragAnchor = off;
    actions.setSelection(off, off + g.width);
  }

  function onMouseMove(e: MouseEvent): void {
    if (dragAnchor === null || (e.buttons & 1) === 0) return;
    const off = offsetAt(e);
    const g = geometry;
    if (off === null || g === null) return;
    actions.setSelection(Math.min(dragAnchor, off), Math.max(dragAnchor, off) + g.width);
  }

  function onMouseUp(): void {
    if (dragAnchor === null) return;
    dragAnchor = null;
    const image = $bin;
    const sel = $selection;
    const g = geometry;
    if (!image || !sel || !g) return;
    if (sel.end - sel.start <= bytesPerRow(g)) return; // sub-row drags stay as dragged
    // Selection assist (spec §7): snap to the engine's best framing.
    const snap = snapSelection(image.bytes, sel.start, sel.end, intFormat);
    if (snap !== null) actions.setSelection(snap.start, snap.end, snap.cols);
  }
</script>

<div class="hexwrap">
  <canvas bind:this={canvas} class="hexcanvas"></canvas>
  <div
    class="hexscroll"
    bind:this={scroller}
    bind:clientWidth={viewportW}
    bind:clientHeight={viewportH}
    onscroll={() => {
      scrollTop = scroller.scrollTop;
    }}
    onmousedown={onMouseDown}
    onmousemove={onMouseMove}
    role="grid"
    tabindex="-1"
  >
    <div style="height: {totalRows * ROW_H}px; width: 1px;"></div>
  </div>
</div>

<svelte:window onmouseup={onMouseUp} />

<style>
  .hexwrap {
    position: absolute;
    inset: 0;
  }
  .hexcanvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .hexscroll {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    cursor: cell;
  }
</style>
