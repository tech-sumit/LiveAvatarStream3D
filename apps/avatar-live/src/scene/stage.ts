import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type Shot = 'close' | 'medium' | 'wide';

export interface CaptureFormat {
  name: string;
  w: number;
  h: number;
}

export interface StageLights {
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
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
  readonly lights = {} as StageLights;

  private el: HTMLElement;
  private gateEl: HTMLElement | null;
  private gate = { left: 0, top: 0, w: 1, h: 1 }; // capture region in canvas px (top-left)
  private clock = new THREE.Clock();
  private updaters: ((dt: number, t: number) => void)[] = [];
  private directorActive = false; // timeline owns the camera (OrbitControls paused)

  // "Screen source": when on, the recorded output cuts to a fullscreen video
  // feed (the studio wall content / a cast tab) instead of the 3D camera.
  private outputSource: 'scene' | 'screen' = 'scene';
  private screenVideo: HTMLVideoElement | null = null;
  private screenScene = new THREE.Scene();
  private screenCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private screenQuad: THREE.Mesh;

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

    // Fullscreen quad (NDC -1..1) for the "screen source" output cut.
    this.screenQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: null, toneMapped: false }),
    );
    this.screenScene.add(this.screenQuad);

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
    // Track the viewport cell directly so docking the timeline (which shrinks
    // #stage without a window resize) keeps the renderer + gate correct.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(this.el);
    }
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

  /** Current camera framing — for capturing a pose / recording a path. */
  getCameraPose(): { pos: THREE.Vector3; target: THREE.Vector3; fov: number } {
    return { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
  }

  /** Nudge the camera (arrow-key navigation). truck = strafe, pedestal = up/down,
   *  dolly>0 = move closer. Keeps the OrbitControls offset consistent. */
  nudgeCamera(truck: number, pedestal: number, dolly: number): void {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
    const pan = right.multiplyScalar(truck).add(new THREE.Vector3(0, pedestal, 0));
    this.camera.position.add(pan);
    this.controls.target.add(pan);
    if (dolly !== 0) {
      const off = this.camera.position.clone().sub(this.controls.target);
      off.setLength(Math.max(0.2, off.length() - dolly));
      this.camera.position.copy(this.controls.target).add(off);
    }
    this.controls.update();
  }

  /** Timeline director takes/releases the camera (OrbitControls paused while on). */
  setDirector(on: boolean): void {
    this.directorActive = on;
    if (!on) this.controls.update();
  }

  /** Directly place the camera (used by the timeline director each frame). */
  setCameraPose(pos: THREE.Vector3, target: THREE.Vector3, fov?: number): void {
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    if (fov && Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  captureStream(fps = 30): MediaStream {
    return this.outputCanvas.captureStream(fps);
  }

  /** Provide the video the "screen source" cut renders (the studio wall feed). */
  setScreenSource(video: HTMLVideoElement | null): void {
    this.screenVideo = video;
    const mat = this.screenQuad.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    if (video) {
      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
    } else {
      mat.map = null;
      this.outputSource = 'scene';
    }
    mat.needsUpdate = true;
  }

  /** Switch the recorded output between the 3D camera and the screen feed. */
  setOutputSource(src: 'scene' | 'screen'): void {
    this.outputSource = src === 'screen' && this.screenVideo ? 'screen' : 'scene';
  }

  get outputIsScreen(): boolean {
    return this.outputSource === 'screen';
  }

  private tick(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    for (const fn of this.updaters) fn(dt, t);
    if (!this.directorActive) this.controls.update(); // director drives the camera directly

    const W = this.el.clientWidth || window.innerWidth;
    const H = this.el.clientHeight || window.innerHeight;

    // Main pass: the full environment view (constant size, independent of the
    // capture format). The camera frustum spans the whole canvas.
    this.camera.clearViewOffset();
    this.renderer.setViewport(0, 0, W, H);
    this.renderer.setClearColor(0x12161f, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // Output pass. Either a fullscreen cut to the screen-source video, or the
    // capture gate (a sub-window of the same frustum) at the capture resolution.
    if (this.outputSource === 'screen' && this.screenVideo && this.screenVideo.readyState >= 2) {
      this.outputRenderer.render(this.screenScene, this.screenCam);
    } else {
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
  }

  private setupLights(): void {
    this.lights.key = new THREE.DirectionalLight(0xfff1e0, 1.6);
    this.lights.key.position.set(1.8, 2.6, 2.4);
    this.lights.key.castShadow = true;
    this.lights.key.shadow.mapSize.set(2048, 2048);
    this.lights.key.shadow.camera.near = 0.5;
    this.lights.key.shadow.camera.far = 20;
    this.lights.key.shadow.bias = -0.0004;
    this.scene.add(this.lights.key);

    this.lights.fill = new THREE.DirectionalLight(0xdfe6ff, 0.35);
    this.lights.fill.position.set(-2.4, 1.2, 1.6);
    this.scene.add(this.lights.fill);

    this.lights.rim = new THREE.DirectionalLight(0xcfe0ff, 0.6);
    this.lights.rim.position.set(-1, 2.4, -2.6);
    this.scene.add(this.lights.rim);

    this.lights.ambient = new THREE.HemisphereLight(0xbcc8e6, 0x20242e, 0.45);
    this.scene.add(this.lights.ambient);
  }

  /** Set a light's intensity (key/fill/rim/ambient). */
  setLightIntensity(name: keyof StageLights, value: number): void {
    const l = this.lights[name];
    if (l) l.intensity = value;
  }

  /** Set a directional light's color (key/fill/rim) from a hex number. */
  setLightColor(name: 'key' | 'fill' | 'rim', hex: number): void {
    this.lights[name]?.color.setHex(hex);
  }

  setExposure(value: number): void {
    this.renderer.toneMappingExposure = value;
    this.outputRenderer.toneMappingExposure = value;
  }

  private setupBackdrop(): void {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(14, 64),
      new THREE.MeshStandardMaterial({ color: 0x0d1422, roughness: 0.4, metalness: 0.5 }),
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
