<!-- apps/desktop/src/views/View2d.svelte -->
<script lang="ts">
  import { bin, scrollRequest, selection, viewParams } from '../store/stores.js';
  import * as actions from '../store/actions.js';
  import { barFraction, defaultRawRange } from '../lib/hexlayout.js';
  import { seriesFromRange } from '../lib/griddata.js';
  import { snapSelection } from '../lib/snap.js';

  /** Horizontal pixels per value — fixed; virtualization handles length. */
  const PPV = 3;

  let scroller: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let viewportW = $state(0);
  let viewportH = $state(0);
  let scrollLeft = $state(0);
  let dragAnchor: number | null = null;

  const cellCount = $derived.by((): number => {
    const image = $bin;
    if (!image) return 0;
    return Math.floor((image.size - $viewParams.origin) / $viewParams.format.width);
  });

  function indexToOffset(index: number): number {
    return $viewParams.origin + index * $viewParams.format.width;
  }

  function draw(): void {
    const image = $bin;
    if (!canvas || !image || viewportW <= 0 || viewportH <= 0) return;
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
    const firstIndex = Math.max(0, Math.floor(scrollLeft / PPV));
    const visible = Math.min(cellCount - firstIndex, Math.ceil(viewportW / PPV) + 1);
    if (visible <= 0) return;
    const values = seriesFromRange(image.bytes, indexToOffset(firstIndex), visible, $viewParams.format);
    const range = $viewParams.valueRange ?? defaultRawRange($viewParams.format);
    const h = viewportH - 20;
    const sel = $selection;
    // selection shading
    if (sel !== null) {
      const w = $viewParams.format.width;
      const selFirst = Math.ceil((sel.start - $viewParams.origin) / w);
      const selLast = Math.floor((sel.end - $viewParams.origin) / w);
      const x0 = (selFirst - firstIndex) * PPV - (scrollLeft % PPV);
      const x1 = (selLast - firstIndex) * PPV - (scrollLeft % PPV);
      ctx.fillStyle = 'rgba(255, 170, 0, 0.15)';
      ctx.fillRect(x0, 0, x1 - x0, viewportH);
    }
    // row-break verticals every `columns` values (spec §7)
    ctx.strokeStyle = 'rgba(154, 160, 166, 0.25)';
    ctx.beginPath();
    const cols = $viewParams.columns;
    for (let i = firstIndex - (firstIndex % cols); i < firstIndex + visible; i += cols) {
      if (i < firstIndex) continue;
      const x = (i - firstIndex) * PPV - (scrollLeft % PPV) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();
    // the curve
    ctx.strokeStyle = '#4c8dff';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = i * PPV - (scrollLeft % PPV);
      const y = h - barFraction(values[i]!, range) * (h - 8) - 4;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // range labels
    ctx.font = '11px Consolas, monospace';
    ctx.fillStyle = '#9aa0a6';
    ctx.fillText(String(range.max), 4, 12);
    ctx.fillText(String(range.min), 4, h - 2);
    ctx.fillText(`0x${indexToOffset(firstIndex).toString(16).toUpperCase()}`, 4, viewportH - 4);
  }

  $effect(() => {
    draw();
  });

  $effect(() => {
    const req = $scrollRequest;
    const image = $bin;
    if (req === null || image === null || !scroller) return;
    const index = Math.max(0, Math.floor((req.offset - $viewParams.origin) / $viewParams.format.width));
    scroller.scrollLeft = Math.max(0, index * PPV - viewportW / 3);
  });

  function offsetAt(e: MouseEvent): number | null {
    const image = $bin;
    if (!image) return null;
    const rect = scroller.getBoundingClientRect();
    const index = Math.floor((e.clientX - rect.left + scrollLeft) / PPV);
    if (index < 0 || index >= cellCount) return null;
    return indexToOffset(index);
  }

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const off = offsetAt(e);
    if (off === null) return;
    dragAnchor = off;
    actions.setSelection(off, off + $viewParams.format.width);
  }

  function onMouseMove(e: MouseEvent): void {
    if (dragAnchor === null || (e.buttons & 1) === 0) return;
    const off = offsetAt(e);
    if (off === null) return;
    actions.setSelection(Math.min(dragAnchor, off), Math.max(dragAnchor, off) + $viewParams.format.width);
  }

  function onMouseUp(): void {
    const anchor = dragAnchor;
    dragAnchor = null;
    const image = $bin;
    const sel = $selection;
    if (anchor === null || !image || !sel) return;
    // Selection assist (spec §7) — same engine snap as the hexdump; snap
    // returns null for ranges too small to frame, so tiny drags stay as-is.
    const { float: _float, ...intFmt } = $viewParams.format;
    const snap = snapSelection(image.bytes, sel.start, sel.end, intFmt);
    if (snap !== null) actions.setSelection(snap.start, snap.end, snap.cols);
  }
</script>

<div class="wrap2d">
  <canvas bind:this={canvas}></canvas>
  <div
    class="scroll2d"
    bind:this={scroller}
    bind:clientWidth={viewportW}
    bind:clientHeight={viewportH}
    onscroll={() => {
      scrollLeft = scroller.scrollLeft;
    }}
    onmousedown={onMouseDown}
    onmousemove={onMouseMove}
    role="grid"
    tabindex="-1"
  >
    <div style="width: {cellCount * PPV}px; height: 1px;"></div>
  </div>
</div>

<svelte:window onmouseup={onMouseUp} />

<style>
  .wrap2d {
    position: absolute;
    inset: 0;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .scroll2d {
    position: absolute;
    inset: 0;
    overflow-x: auto;
    overflow-y: hidden;
    cursor: crosshair;
  }
</style>
