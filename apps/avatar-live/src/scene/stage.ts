import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildLookChain, applyLookParams, DEFAULT_LOOK, type LookParams, type LookChain } from '../look/lookChain.js';

const _afCam = new THREE.Vector3();
const _afTgt = new THREE.Vector3();

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
  private viewportLook!: LookChain;
  private outputLook!: LookChain;
  private lookParams: LookParams = { ...DEFAULT_LOOK };
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
  private outputSource: 'scene' | 'screen' = 'scene'; // live output (may be overridden by a cut)
  private manualSource: 'scene' | 'screen' = 'scene'; // the user's sticky preference
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
    this.renderer.toneMapping = THREE.NoToneMapping; // ToneMappingEffect (ACES) owns tone mapping now
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
    this.outputRenderer.toneMapping = THREE.NoToneMapping; // ToneMappingEffect (ACES) owns tone mapping now
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

    // Post-processing "look" composers: one over the live viewport renderer,
    // one over the capture/export renderer (so the recorded MP4 inherits the look).
    this.viewportLook = buildLookChain(this.renderer, this.scene, this.camera, this.lookParams);
    this.outputLook = buildLookChain(this.outputRenderer, this.scene, this.camera, this.lookParams);

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

  /** Aim the camera at the face (head center) at eye level; distance from the
   *  head height + shot. Camera height is aligned to the face for every shot. */
  frame(headCenter: THREE.Vector3, headHeight: number, shot: Shot = 'medium', snap = true): void {
    // News framing: eye-level camera; the look-at drops slightly toward the chest (more
    // on wider shots) so the frame reveals neck + torso while keeping the FACE comfortably
    // in the upper third — a head-and-shoulders anchor shot, not a torso crop.
    const factor = shot === 'close' ? 4.0 : shot === 'medium' ? 5.5 : 8.0;
    const drop = shot === 'close' ? 0.25 : shot === 'medium' ? 0.6 : 1.1;
    const dist = headHeight * factor;
    this.controls.target.set(headCenter.x, headCenter.y - headHeight * drop, headCenter.z);
    if (snap) {
      this.camera.position.set(headCenter.x, headCenter.y, headCenter.z + dist);
    }
    this.controls.update();
  }

  /** Snap the current free camera to look at the face at eye level, preserving
   *  the horizontal direction + distance (the one-shot "align to face"). */
  alignToFace(face: THREE.Vector3): void {
    this.controls.target.copy(face);
    this.camera.position.y = face.y;
    this.camera.lookAt(face);
    this.controls.update();
  }

  /** Soft per-frame pull toward a face-level framing (the auto-align toggle). */
  softAlignToFace(face: THREE.Vector3, k = 0.12): void {
    this.controls.target.lerp(face, k);
    this.camera.position.y += (face.y - this.camera.position.y) * k;
  }

  /**
   * Frame the anchor and the screen side-by-side (a two-shot), dollying so both fit, and
   * smoothly following the anchor as it walks. This is the presenter-beside-screen view —
   * it replaces the face close-up so the screen is always in shot alongside the anchor.
   */
  frameAnchorScreen(anchor: THREE.Vector3, screen: THREE.Vector3, dt: number): void {
    const mx = (anchor.x + screen.x) / 2;
    const mz = (anchor.z + screen.z) / 2;
    const spread = Math.hypot(anchor.x - screen.x, anchor.z - screen.z);
    const fov = 40;
    // Distance to fit both, sitting a little further back (matches the captured framing).
    const dist = (spread + 2.75) / (2 * Math.tan((fov * Math.PI) / 360));
    const camZ = Math.max(anchor.z, screen.z) + dist;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const k = 1 - Math.exp(-dt / 0.45);
    // Captured composition: camera offset ~1.1 LEFT of the midpoint and raised to 1.75,
    // looking slightly right/up and a touch forward — so the anchor reads on the left and
    // the screen on the right (a news two-shot), following the anchor as it moves.
    this.controls.target.lerp(_afTgt.set(mx + 0.1, 1.25, mz + 0.9), k);
    this.camera.position.lerp(_afCam.set(mx - 1.1, 1.75, camZ), k);
    this.camera.lookAt(this.controls.target);
  }

  setCaptureFormat(fmt: CaptureFormat): void {
    this.capture = fmt;
    this.outputRenderer.setSize(fmt.w, fmt.h, false);
    this.outputLook?.composer.setSize(fmt.w, fmt.h, false); // guarded: called once during construction before composers exist
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

  /**
   * Render the capture-gate sub-window into the output renderer — the exact pixels that
   * get recorded/encoded. The gate is a contain-fit of the capture aspect inside the
   * viewport, so cropping to it via setViewOffset and rendering into the capture-sized
   * output buffer keeps the frame undistorted at any format. Shared by the live loop
   * (tick) and the offline exporter so the MP4 is pixel-identical to the on-screen OUTPUT
   * monitor. (Previously the export rendered the full viewport-aspect frustum, which
   * stretched the frame and showed a wider crop than the gate.)
   */
  private renderSceneOutput(): void {
    const W = this.el.clientWidth || window.innerWidth;
    const H = this.el.clientHeight || window.innerHeight;
    const g = this.gate;
    const saved = this.hideInOutput.map((o) => o.visible);
    this.hideInOutput.forEach((o) => (o.visible = false));
    this.camera.setViewOffset(W, H, g.left, g.top, g.w, g.h);
    this.camera.updateProjectionMatrix();
    this.outputLook.composer.render();
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.hideInOutput.forEach((o, i) => (o.visible = saved[i]));
  }

  /**
   * Scrub the back-wall screen video to time t. The offline export calls this per frame
   * so a wall montage advances in lockstep with the rendered frame index — the realtime
   * <video> clock can't keep up while the main thread is busy encoding, so without this
   * the wall appears frozen on an early frame. Loops via the video's duration.
   */
  seekScreen(t: number): void {
    const v = this.screenVideo;
    if (!v || !v.duration || !isFinite(v.duration)) return;
    try {
      v.currentTime = t % v.duration;
    } catch {
      /* not seekable yet */
    }
  }

  /**
   * Render one output frame on demand (offline export) and return the capture
   * canvas. Mirrors the per-frame output render in the internal loop, but is
   * called synchronously by the exporter rather than by requestAnimationFrame.
   */
  renderOutputFrame(): HTMLCanvasElement {
    if (this.outputIsScreen) {
      this.outputRenderer.render(this.screenScene, this.screenCam);
    } else {
      this.renderSceneOutput();
    }
    return this.outputCanvas;
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
      this.manualSource = 'scene';
      this.outputSource = 'scene';
    }
    mat.needsUpdate = true;
  }

  /** Manual toggle of the recorded output (sticky user preference). */
  setOutputSource(src: 'scene' | 'screen'): void {
    this.manualSource = src === 'screen' && this.screenVideo ? 'screen' : 'scene';
    this.outputSource = this.manualSource;
  }

  /** Director-driven cut during a performance; reverts to the manual source when inactive. */
  setScreenCut(active: boolean): void {
    this.outputSource = active && this.screenVideo ? 'screen' : this.manualSource;
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
    this.viewportLook.composer.render();

    // Output pass. Either a fullscreen cut to the screen-source video, or the
    // capture gate (a sub-window of the same frustum) at the capture resolution.
    if (this.outputSource === 'screen' && this.screenVideo && this.screenVideo.readyState >= 2) {
      this.outputRenderer.render(this.screenScene, this.screenCam);
    } else {
      this.renderSceneOutput();
    }
  }

  private setupLights(): void {
    // Bright broadcast set: strong warm key + generous fill/ambient so the stage reads
    // light and well-lit (not a dark void), a cool rim for separation, and a soft top wash.
    this.lights.key = new THREE.DirectionalLight(0xfff4e8, 2.7);
    this.lights.key.position.set(2.0, 3.0, 2.8);
    this.lights.key.castShadow = true;
    this.lights.key.shadow.mapSize.set(2048, 2048);
    this.lights.key.shadow.camera.near = 0.5;
    this.lights.key.shadow.camera.far = 20;
    this.lights.key.shadow.bias = -0.0004;
    this.scene.add(this.lights.key);

    this.lights.fill = new THREE.DirectionalLight(0xeaf0ff, 1.15);
    this.lights.fill.position.set(-2.6, 1.6, 1.8);
    this.scene.add(this.lights.fill);

    this.lights.rim = new THREE.DirectionalLight(0xdce8ff, 1.0);
    this.lights.rim.position.set(-1.2, 2.8, -2.8);
    this.scene.add(this.lights.rim);

    this.lights.ambient = new THREE.HemisphereLight(0xdfe8ff, 0x3a4250, 0.95);
    this.scene.add(this.lights.ambient);

    const top = new THREE.DirectionalLight(0xffffff, 0.5);
    top.position.set(0, 5, 0.5);
    this.scene.add(top);
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

  /** Update the post-processing look on both the viewport and the capture/export composers. */
  setLook(params: LookParams): void {
    this.lookParams = { ...params };
    applyLookParams(this.viewportLook.fx, this.lookParams);
    applyLookParams(this.outputLook.fx, this.lookParams);
  }

  /** Current look params (for serialization). */
  getLook(): LookParams {
    return { ...this.lookParams };
  }

  private setupBackdrop(): void {
    // Brighter, less mirror-like studio floor.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(18, 64),
      new THREE.MeshStandardMaterial({ color: 0x222b3a, roughness: 0.6, metalness: 0.25 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Curved cyclorama backdrop: the inner surface of a large cylinder arc wrapping behind
    // the set, so the background reads as continuous curved "studio space" rather than a flat
    // wall. Lit by the rig above.
    const cyc = new THREE.Mesh(
      new THREE.CylinderGeometry(11, 11, 9, 80, 1, true, Math.PI * 0.62, Math.PI * 1.26),
      new THREE.MeshStandardMaterial({ color: 0x39455c, roughness: 0.95, metalness: 0.0, side: THREE.BackSide }),
    );
    cyc.position.set(0, 3.6, -1.2);
    cyc.receiveShadow = true;
    this.scene.add(cyc);

    // Lift the scene background to match the lit set (no near-black void edges).
    this.scene.background = new THREE.Color(0x2b3346);
  }

  private resize(): void {
    const w = this.el.clientWidth || window.innerWidth;
    const h = this.el.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.viewportLook?.composer.setSize(w, h, false); // guarded: resize() runs in the constructor before composers exist
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
