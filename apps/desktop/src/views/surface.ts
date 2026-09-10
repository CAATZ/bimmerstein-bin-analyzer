import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SurfaceGrid } from '../lib/griddata.js';

/** Shared, render-on-demand surface. Plotting never changes the underlying table. */
export class SurfaceRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  private readonly controls: OrbitControls;
  private readonly plot = new THREE.Group();
  private readonly labels: { element: HTMLElement; position: THREE.Vector3 }[] = [];
  private width = 0;
  private height = 0;

  constructor(canvas: HTMLCanvasElement, private readonly overlay: HTMLDivElement, private readonly compact = false) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(0x1b1d21);
    this.camera.position.set(2.4, 2, 2.7);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.plot);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 8;
    this.controls.addEventListener('change', () => this.render());
    this.controls.saveState();
  }

  reset(): void {
    this.controls.reset();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (cssWidth <= 0 || cssHeight <= 0) return;
    this.width = cssWidth;
    this.height = cssHeight;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssWidth, cssHeight, false);
    this.camera.aspect = cssWidth / cssHeight;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private clear(): void {
    for (const child of [...this.plot.children]) {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
      this.plot.remove(child);
    }
    this.labels.length = 0;
    this.overlay.replaceChildren();
  }

  private label(text: string, x: number, y: number, z: number, heading = false): void {
    const element = document.createElement('span');
    element.className = heading ? 'surface-label surface-axis' : 'surface-label';
    element.textContent = text;
    this.overlay.append(element);
    this.labels.push({ element, position: new THREE.Vector3(x, y, z) });
  }

  setGrid(grid: SurfaceGrid | null): void {
    this.clear();
    if (grid === null || grid.rows < 2 || grid.cols < 2) { this.render(); return; }
    const title = document.createElement('div');
    title.className = 'surface-title';
    title.textContent = grid.valueLabel ?? 'Value (raw)';
    this.overlay.append(title);
    if (!grid.values.every((row) => row.every(Number.isFinite))) {
      title.textContent = 'Cannot plot non-finite values';
      this.render();
      return;
    }

    // Cell spacing matches Map view; tick text carries the actual breakpoints.
    const depth = 1.4 * Math.max(0.6, Math.min(1.4, grid.rows / grid.cols));
    const base = -0.35;
    const top = 0.45;
    const geo = new THREE.PlaneGeometry(1.4, depth, grid.cols - 1, grid.rows - 1);
    geo.rotateX(-Math.PI / 2);
    const span = grid.max - grid.min || 1;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const color = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const r = Math.floor(i / grid.cols);
      const c = i % grid.cols;
      const t = (grid.values[r]![c]! - grid.min) / span;
      pos.setY(i, base + t * (top - base));
      color.setHSL(0.66 * (1 - t), 0.8, 0.5);
      colors.set([color.r, color.g, color.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.plot.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })));

    const edges: number[] = [];
    const segment = (a: number[], b: number[]): void => { edges.push(...a, ...b); };
    const point = (i: number): number[] => [pos.getX(i), pos.getY(i), pos.getZ(i)];
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      if (c + 1 < grid.cols) segment(point(i), point(i + 1));
      if (r + 1 < grid.rows) segment(point(i), point(i + grid.cols));
    }
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      segment([-0.7 + t * 1.4, base, -depth / 2], [-0.7 + t * 1.4, base, depth / 2]);
      segment([-0.7, base, (t - 0.5) * depth], [0.7, base, (t - 0.5) * depth]);
    }
    segment([-0.7, base, depth / 2], [-0.7, top, depth / 2]);
    this.plot.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',
      new THREE.Float32BufferAttribute(edges, 3)), new THREE.LineBasicMaterial({ color: 0xa7b9cc, transparent: true, opacity: 0.5 })));

    const ticks = this.compact ? 3 : 5;
    const axisTicks = (count: number, show: (i: number) => void): void => {
      const n = Math.min(ticks, count);
      for (let j = 0; j < n; j++) show(Math.round(j * (count - 1) / (n - 1)));
    };
    axisTicks(grid.cols, (i) => this.label(grid.xAxis?.values[i] ?? String(i), -0.7 + i * 1.4 / (grid.cols - 1), base - 0.08, depth / 2 + (this.compact ? 0.25 : 0.09)));
    axisTicks(grid.rows, (i) => this.label(grid.yAxis?.values[i] ?? String(i), this.compact ? 0.97 : 0.82, base - 0.08, -depth / 2 + i * depth / (grid.rows - 1)));
    if (this.compact) {
      const legend = document.createElement('div');
      legend.className = 'surface-legend';
      legend.textContent = `X: ${grid.xAxis?.label ?? 'index'} · Y: ${grid.yAxis?.label ?? 'index'}`;
      this.overlay.append(legend);
    } else {
      this.label(grid.xAxis?.label ?? 'X (index)', 0, base - 0.22, depth / 2 + 0.3, true);
      this.label(grid.yAxis?.label ?? 'Y (index)', 1.08, base - 0.2, 0, true);
    }
    const digits = Math.min(8, Math.max(0, Math.trunc(grid.digits ?? 0)));
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      this.label((grid.min + (grid.max - grid.min) * t).toFixed(digits), -0.85, base + t * (top - base), depth / 2);
    }
    this.render();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
    const placed: DOMRect[] = [];
    // Keep axis names first; hide colliding ticks as the camera turns.
    const labels = [...this.labels].sort((a, b) => Number(b.element.classList.contains('surface-axis')) - Number(a.element.classList.contains('surface-axis')));
    for (const { element, position } of labels) {
      const projected = position.clone().project(this.camera);
      element.style.left = `${(projected.x + 1) * this.width / 2}px`;
      element.style.top = `${(1 - projected.y) * this.height / 2}px`;
      element.hidden = projected.z < -1 || projected.z > 1;
      if (element.hidden) continue;
      const rect = element.getBoundingClientRect();
      if (placed.some((r) => rect.left < r.right + 3 && rect.right > r.left - 3 && rect.top < r.bottom + 2 && rect.bottom > r.top - 2)) element.hidden = true;
      else placed.push(rect);
    }
  }

  dispose(): void {
    this.clear();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
