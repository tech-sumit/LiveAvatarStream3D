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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
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

  /**
   * Aim the camera at a head center and choose a framing distance proportional
   * to the head height (so any avatar scale frames consistently). `snap` jumps
   * the camera immediately instead of easing — used for the initial framing and
   * when a tab is backgrounded (rAF throttled), where easing would never finish.
   */
  frame(headCenter: THREE.Vector3, headHeight: number, shot: Shot = this.shot, snap = true): void {
    this.shot = shot;
    this.camTarget.copy(headCenter);
    const factor = shot === 'close' ? 2.0 : shot === 'medium' ? 3.4 : 6.5;
    const dist = headHeight * factor;
    const yOff = shot === 'close' ? headHeight * 0.04 : -headHeight * 0.08;
    this.camDesired.set(headCenter.x, headCenter.y + yOff, headCenter.z + dist);
    this.lookDesired.set(headCenter.x, headCenter.y, headCenter.z);
    if (snap) {
      this.camPos.copy(this.camDesired);
      this.camLook.copy(this.lookDesired);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
    }
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
    // Soft three-point studio. Warm key, gentle neutral fill, cool rim — tuned
    // so real skin textures read naturally rather than blowing out to white.
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
