import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type Shot = 'close' | 'medium' | 'wide';

// The render surface + cameras. The MAIN camera is user-controlled via
// OrbitControls (rotate / zoom / pan) — this is the virtual camera that gets
// recorded. A second PiP camera renders a fixed front-on framing into a small
// inset (bottom-left) as a reference monitor while you orbit the main view.
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private pipCamera: THREE.PerspectiveCamera;
  private pipEnabled = true;
  private el: HTMLElement;
  private clock = new THREE.Clock();
  private updaters: ((dt: number, t: number) => void)[] = [];

  constructor(container: HTMLElement) {
    this.el = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false; // we manage clears for the PiP pass
    this.el.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x12161f);
    this.scene.fog = new THREE.Fog(0x12161f, 6, 14);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 1.5, 2);
    this.pipCamera = new THREE.PerspectiveCamera(28, 0.8, 0.1, 100);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 1.5, 0);
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 8;

    this.setupLights();
    this.setupBackdrop();
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

  /** Point both cameras at a head center; choose distance from head height. */
  frame(headCenter: THREE.Vector3, headHeight: number, shot: Shot = 'medium', snap = true): void {
    const factor = shot === 'close' ? 2.0 : shot === 'medium' ? 3.4 : 6.5;
    const dist = headHeight * factor;
    this.controls.target.copy(headCenter);
    if (snap) {
      const yOff = shot === 'close' ? headHeight * 0.04 : -headHeight * 0.08;
      this.camera.position.set(headCenter.x, headCenter.y + yOff, headCenter.z + dist);
    }
    this.controls.update();

    // PiP: fixed front-on medium framing of the head.
    const pipDist = headHeight * 3.2;
    this.pipCamera.position.set(headCenter.x, headCenter.y, headCenter.z + pipDist);
    this.pipCamera.lookAt(headCenter);
  }

  setPip(on: boolean): void {
    this.pipEnabled = on;
  }

  captureStream(fps = 30): MediaStream {
    return (this.renderer.domElement as HTMLCanvasElement).captureStream(fps);
  }

  private tick(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    for (const fn of this.updaters) fn(dt, t);
    this.controls.update();

    const W = this.el.clientWidth || window.innerWidth;
    const H = this.el.clientHeight || window.innerHeight;

    // Main pass (full frame).
    this.renderer.setViewport(0, 0, W, H);
    this.renderer.setScissorTest(false);
    this.renderer.setClearColor(0x12161f, 1);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);

    // PiP pass (bottom-left inset).
    if (this.pipEnabled) {
      const pw = Math.round(W * 0.24);
      const ph = Math.round(pw * 1.25);
      const m = 16;
      this.pipCamera.aspect = pw / ph;
      this.pipCamera.updateProjectionMatrix();
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(m, m, pw, ph);
      this.renderer.setScissor(m, m, pw, ph);
      this.renderer.setClearColor(0x0a0d14, 1);
      this.renderer.clear(true, true, false);
      this.renderer.render(this.scene, this.pipCamera);
      this.renderer.setScissorTest(false);
    }
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
