// apps/desktop/src/views/surface.ts
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SurfaceGrid } from '../lib/griddata.js';

/**
 * Shared three.js surface for View3d (interactive orbit) and PreviewPanel
 * (static iso). Render-on-demand: we render on resize/setGrid/orbit-change —
 * no animation loop. dispose() releases geometry, material, controls and the
 * GL context (three cannot auto-free GPU resources).
 */
export class SurfaceRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private mesh: THREE.Mesh | null = null;

  constructor(canvas: HTMLCanvasElement, interactive: boolean) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(0x1b1d21);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.camera.position.set(1.5, 1.2, 1.5);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const light = new THREE.DirectionalLight(0xffffff, 1.4);
    light.position.set(2, 3, 1.5);
    this.scene.add(light);
    if (interactive) {
      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.addEventListener('change', () => this.render());
    }
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (cssWidth <= 0 || cssHeight <= 0) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssWidth, cssHeight, false);
    this.camera.aspect = cssWidth / cssHeight;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  /** Replace the surface. null (or a <2×2 grid) clears it. */
  setGrid(grid: SurfaceGrid | null): void {
    if (this.mesh !== null) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    if (grid !== null && grid.rows >= 2 && grid.cols >= 2) {
      // x spans cols, z spans rows, y is the (normalized) value.
      const depth = 1.4 * Math.min(2.5, grid.rows / grid.cols);
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
        pos.setY(i, t * 0.55);
        color.setHSL(0.66 * (1 - t), 0.85, 0.5); // blue (low) → red (high)
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      pos.needsUpdate = true;
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        metalness: 0,
        roughness: 0.85,
      });
      this.mesh = new THREE.Mesh(geo, mat);
      this.scene.add(this.mesh);
    }
    this.render();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.setGrid(null);
    this.controls?.dispose();
    this.renderer.dispose();
  }
}
