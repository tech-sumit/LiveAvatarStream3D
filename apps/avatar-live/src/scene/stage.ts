import * as THREE from 'three';

export type Shot = 'close' | 'medium' | 'wide';

// The render surface + virtual camera. Owns the rAF loop, a three-point-ish
// light setup, a soft backdrop, and camera framing. The canvas IS the virtual
// camera — Recorder captures its stream. Subscribers get a per-frame callback
// with delta time to advance the avatar/lipsync.
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private el: HTMLElement;
  private clock = new THREE.Clock();
  private updaters: ((dt: number, t: number) => void)[] = [];

  private camTarget = new THREE.Vector3(0, 1.6, 0);
  private camDesired = new THREE.Vector3(0, 1.6, 2.2);
  private lookDesired = new THREE.Vector3(0, 1.6, 0);
  private camPos = new THREE.Vector3(0, 1.6, 2.2);
  private camLook = new THREE.Vector3(0, 1.6, 0);
  private shot: Shot = 'medium';

  constructor(container: HTMLElement) {
    this.el = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.el.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x12161f);
    this.scene.fog = new THREE.Fog(0x12161f, 6, 14);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.copy(this.camPos);

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

  /** Aim the camera at a head center and choose a framing distance. */
  frame(headCenter: THREE.Vector3, shot: Shot = this.shot): void {
    this.shot = shot;
    this.camTarget.copy(headCenter);
    const dist = shot === 'close' ? 0.85 : shot === 'medium' ? 1.7 : 3.0;
    const height = shot === 'close' ? headCenter.y + 0.02 : headCenter.y - 0.05;
    this.camDesired.set(headCenter.x, height, headCenter.z + dist);
    this.lookDesired.set(headCenter.x, headCenter.y, headCenter.z);
  }

  captureStream(fps = 30): MediaStream {
    return (this.renderer.domElement as HTMLCanvasElement).captureStream(fps);
  }

  private tick(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    for (const fn of this.updaters) fn(dt, t);

    // Smoothly ease the camera toward its framing, with a gentle handheld drift.
    const ease = 1 - Math.exp(-dt / 0.4);
    this.camPos.lerp(this.camDesired, ease);
    this.camLook.lerp(this.lookDesired, ease);
    const drift = new THREE.Vector3(Math.sin(t * 0.27) * 0.012, Math.sin(t * 0.21) * 0.008, 0);
    this.camera.position.copy(this.camPos).add(drift);
    this.camera.lookAt(this.camLook);

    this.renderer.render(this.scene, this.camera);
  }

  private setupLights(): void {
    const key = new THREE.DirectionalLight(0xfff2e6, 2.2);
    key.position.set(2.5, 4, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 20;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x88aaff, 0.7);
    fill.position.set(-3, 1.5, 2);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 1.1);
    rim.position.set(-1, 3, -3);
    this.scene.add(rim);

    this.scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x202028, 0.5));
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
