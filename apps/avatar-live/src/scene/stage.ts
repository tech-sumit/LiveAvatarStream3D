import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type Shot = 'close' | 'medium' | 'wide';

export interface CaptureFormat {
  name: string;
  w: number;
  h: number;
}

// Unity-style camera + capture. There is ONE virtual camera (orbit/zoom/pan to
// adjust). The main canvas shows that camera letterboxed to the chosen capture
// aspect — the frame edge is the "capture space" (drawn by the #cameraGate
// overlay). A second renderer outputs the SAME camera at the full capture
// resolution into a clean canvas (no gizmo); recording captures that, so the
// editor (gate, preview, sidebar) stays interactive during recording.
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private outputRenderer: THREE.WebGLRenderer;
  private outputCanvas: HTMLCanvasElement;
  private capture: CaptureFormat = { name: '16:9 · 720p', w: 1280, h: 720 };
  private hideInOutput: THREE.Object3D[] = [];

  private el: HTMLElement;
  private gateEl: HTMLElement | null;
  private gate = { left: 0, top: 0, w: 1, h: 1 }; // capture region in canvas px (top-left)
  private clock = new THREE.Clock();
  private updaters: ((dt: number, t: number) => void)[] = [];

  constructor(container: HTMLElement) {
    this.el = container;
    this.gateEl = document.getElementById('cameraGate');

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.el.appendChild(this.renderer.domElement);

    // Clean output canvas for recording + the bottom-left monitor.
    this.outputCanvas = document.createElement('canvas');
    this.outputRenderer = new THREE.WebGLRenderer({
      canvas: this.outputCanvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.outputRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.outputRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.outputRenderer.toneMappingExposure = 1.05;
    this.outputRenderer.shadowMap.enabled = true;
    this.outputRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('pipFrame')?.appendChild(this.outputCanvas);

    this.scene.background = new THREE.Color(0x12161f);
    this.scene.fog = new THREE.Fog(0x12161f, 6, 14);

    this.camera = new THREE.PerspectiveCamera(35, this.capture.w / this.capture.h, 0.1, 100);
    this.camera.position.set(0, 1.5, 2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 1.5, 0);
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 8;

    this.setupLights();
    this.setupBackdrop();
    this.setCaptureFormat(this.capture);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.tick());
  }

  add(obj: THREE.Object3D): void {
    this.scene.add(obj);
  }

  onFrame(fn: (dt: number, t: number) => void): void {
    this.updaters.push(fn);
  }

  /** Objects to omit from the recorded output (e.g. the transform gizmo). */
  excludeFromCapture(obj: THREE.Object3D): void {
    this.hideInOutput.push(obj);
  }

  /** Aim the camera at a head center; distance from head height + shot. */
  frame(headCenter: THREE.Vector3, headHeight: number, shot: Shot = 'medium', snap = true): void {
    const factor = shot === 'close' ? 2.0 : shot === 'medium' ? 3.4 : 6.5;
    const dist = headHeight * factor;
    this.controls.target.copy(headCenter);
    if (snap) {
      const yOff = shot === 'close' ? headHeight * 0.04 : -headHeight * 0.08;
      this.camera.position.set(headCenter.x, headCenter.y + yOff, headCenter.z + dist);
    }
    this.controls.update();
  }

  setCaptureFormat(fmt: CaptureFormat): void {
    this.capture = fmt;
    this.outputRenderer.setSize(fmt.w, fmt.h, false);
    const pip = document.getElementById('pipFrame');
    if (pip) pip.style.aspectRatio = `${fmt.w} / ${fmt.h}`;
    this.resize(); // recomputes the capture gate within the constant environment view
  }

  captureLabel(): string {
    return `${this.capture.name} (${this.capture.w}×${this.capture.h})`;
  }

  cameraWorldPosition(): THREE.Vector3 {
    return this.camera.position.clone();
  }

  captureStream(fps = 30): MediaStream {
    return this.outputCanvas.captureStream(fps);
  }

  private tick(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    for (const fn of this.updaters) fn(dt, t);
    this.controls.update();

    const W = this.el.clientWidth || window.innerWidth;
    const H = this.el.clientHeight || window.innerHeight;

    // Main pass: the full environment view (constant size, independent of the
    // capture format). The camera frustum spans the whole canvas.
    this.camera.clearViewOffset();
    this.renderer.setViewport(0, 0, W, H);
    this.renderer.setClearColor(0x12161f, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // Output pass: render exactly the capture gate (a sub-window of the same
    // frustum) into the output canvas at the capture resolution. Gizmo hidden.
    const g = this.gate;
    const saved = this.hideInOutput.map((o) => o.visible);
    this.hideInOutput.forEach((o) => (o.visible = false));
    this.camera.setViewOffset(W, H, g.left, g.top, g.w, g.h);
    this.camera.updateProjectionMatrix();
    this.outputRenderer.render(this.scene, this.camera);
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.hideInOutput.forEach((o, i) => (o.visible = saved[i]));
  }

  private setupLights(): void {
    const key = new THREE.DirectionalLight(0xfff1e0, 1.6);
    key.position.set(1.8, 2.6, 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 20;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xdfe6ff, 0.35);
    fill.position.set(-2.4, 1.2, 1.6);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xcfe0ff, 0.6);
    rim.position.set(-1, 2.4, -2.6);
    this.scene.add(rim);

    this.scene.add(new THREE.HemisphereLight(0xbcc8e6, 0x20242e, 0.45));
  }

  private setupBackdrop(): void {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(8, 48),
      new THREE.MeshStandardMaterial({ color: 0x1b2130, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  private resize(): void {
    const w = this.el.clientWidth || window.innerWidth;
    const h = this.el.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; // environment view fills the canvas
    this.camera.updateProjectionMatrix();

    // Capture gate = contain-fit of the capture aspect inside the canvas. Marks
    // the region the virtual camera records (drawn as the #cameraGate overlay).
    const cap = this.capture.w / this.capture.h;
    const ca = w / h;
    let gw: number;
    let gh: number;
    if (cap > ca) {
      gw = w;
      gh = w / cap;
    } else {
      gh = h;
      gw = h * cap;
    }
    const left = (w - gw) / 2;
    const top = (h - gh) / 2;
    this.gate = { left, top, w: gw, h: gh };

    if (this.gateEl) {
      this.gateEl.style.left = `${left}px`;
      this.gateEl.style.top = `${top}px`;
      this.gateEl.style.width = `${gw}px`;
      this.gateEl.style.height = `${gh}px`;
    }
  }
}
