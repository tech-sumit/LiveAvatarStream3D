import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { zeroChannels, type FaceChannels, type FaceRig } from './face.js';
import { MorphFaceRig } from './morphRig.js';
import { JawBoneRig } from './jawBoneRig.js';
import { createProceduralHead } from './proceduralHead.js';
import { emotionBias, type EmotionName } from './emotion.js';

// Outcome of loading an external model, so the UI can explain what happened.
export interface LoadResult {
  mode: 'morphs' | 'jawbone' | 'none';
  detail: string;
}

// Owns the avatar object + its FaceRig. Receives target lipsync/emotion values
// and, each render tick, smooths the actual channels toward them, layers in
// auto-blink and idle breathing, then writes to the rig. Separating "target"
// (set by the speech pipeline at audio rate) from "current" (advanced per frame)
// is what keeps mouth motion smooth regardless of how chunky the audio cues are.
export interface MouthCue {
  jawOpen: number;
  mouthWide: number;
  mouthRound: number;
  mouthClose: number;
}

const SILENT: MouthCue = { jawOpen: 0, mouthWide: 0, mouthRound: 0, mouthClose: 0 };

// scratch objects for gaze math (avoid per-frame allocation)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _q = new THREE.Quaternion();

const EYE_LOOK = [
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeLookDownLeft',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight',
  'eyeLookDownRight',
] as const;

export class AvatarController {
  readonly group = new THREE.Group(); // outer: user X/Y/Z offset (sliders)
  private motion = new THREE.Group(); // inner: idle sway/breathing; holds avatar
  headCenter = new THREE.Vector3(0, 1.5, 0);
  headHeight = 0.42; // world-space head height, drives camera framing distance
  description = 'procedural head';

  private rig: FaceRig;
  private current: FaceChannels = zeroChannels();
  private mouthTarget: MouthCue = { ...SILENT };
  private namedFace: Record<string, number> | null = null;
  private gazeTarget: THREE.Vector3 | null = null;
  private gazeWeights: Record<string, number> = {};
  private emotion: EmotionName = 'neutral';
  private emotionIntensity = 1;
  private speaking = false;

  // blink state
  private nextBlinkAt = 1.5;
  private blinkClock = 0;
  private blinkPhase = -1; // -1 idle, else 0..1 progress

  // idle motion
  private idleClock = 0;
  private idleMotion = false; // default: avatar holds still (no breathing/sway)
  private idleHoldT = 0; // time spent settling the current pose before freezing

  // Renderer is needed for KTX2 transcoder support detection.
  private renderer: THREE.WebGLRenderer | null = null;

  // Skeletal body animation (Ready Player Me avatars only — license-gated).
  isReadyPlayerMe = false;
  private animRoot: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private currentClip = '';

  constructor() {
    const head = createProceduralHead();
    // The procedural head is modeled at ~1m radius for easy authoring; scale it
    // to human proportions and lift it to standing eye height so the virtual
    // camera's framing distances (tuned for a real head) read correctly.
    head.group.scale.setScalar(0.18);
    head.group.position.y = 1.5;
    this.group.add(this.motion);
    this.motion.add(head.group);
    this.rig = head.rig;
    this.headCenter = new THREE.Vector3(0, 1.53, 0);
  }

  setRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
  }

  /** Translate the whole avatar (X/Y/Z editor sliders). */
  setPosition(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
  }

  // Director turn: smoothly rotate the avatar about Y (e.g. toward the screen).
  private turnTarget = 0;
  setTurn(angleRad: number): void {
    this.turnTarget = angleRad;
  }

  /**
   * Load an external glTF/GLB. Uses facial blendshapes if present (full visemes),
   * else falls back to a jaw bone (open/close only), else reports that the model
   * has a frozen face and keeps the current avatar.
   */
  async loadGltf(url: string): Promise<LoadResult> {
    const loader = new GLTFLoader();
    // Support compressed avatars (RPM, facecap, etc.): Draco geometry, meshopt,
    // and KTX2/basis textures. Decoder assets are served from /decoders/.
    const draco = new DRACOLoader().setDecoderPath('/decoders/draco/');
    loader.setDRACOLoader(draco);
    loader.setMeshoptDecoder(MeshoptDecoder);
    if (this.renderer) {
      const ktx2 = new KTX2Loader().setTranscoderPath('/decoders/basis/').detectSupport(this.renderer);
      loader.setKTX2Loader(ktx2);
    }

    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;

    const morphRig = new MorphFaceRig(root);
    if (morphRig.boundCount > 0) {
      this.swapTo(root, morphRig, fitAvatar(root, faceMeshOf(root)));
      this.description = `glTF · ${morphRig.boundNames.length} ARKit/viseme morphs`;
      return { mode: 'morphs', detail: this.description };
    }

    const jawRig = new JawBoneRig(root);
    if (jawRig.found) {
      this.swapTo(root, jawRig, fitAvatar(root, null));
      this.description = `glTF · jaw-bone lipsync (no blendshapes — open/close only)`;
      return { mode: 'jawbone', detail: this.description };
    }

    // Frozen face — nothing to animate. Keep whatever avatar we had.
    return {
      mode: 'none',
      detail: 'no facial blendshapes and no jaw bone — this model has a frozen face and cannot lip-sync',
    };
  }

  private swapTo(root: THREE.Object3D, rig: FaceRig, fit: { center: THREE.Vector3; height: number }): void {
    this.motion.clear();
    this.motion.add(root);
    this.rig = rig;
    this.current = zeroChannels();
    this.headCenter = fit.center;
    this.headHeight = fit.height;
    // Reset animation state for the new avatar.
    this.animRoot = root;
    this.mixer = null;
    this.actions = {};
    this.currentClip = '';
    // Auto-detect a retargetable humanoid: the core RPM/Mixamo bones the body
    // clips target. Used for ad-hoc (file/URL) loads; discovered avatars override
    // this via config.bodyAnim, because identical bone names don't guarantee a
    // compatible bind pose (MPFB/MakeHuman + VRoid share the names but their rest
    // pose distorts under RPM clips, so their config sets bodyAnim:false).
    const bones = new Set<string>();
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.add(o.name);
    });
    this.isReadyPlayerMe = bones.has('Hips') && bones.has('Head') && (bones.has('LeftArm') || bones.has('RightArm'));
  }

  /**
   * Load skeletal body-animation clips (one AnimationClip per glb) and bind them
   * to the avatar's skeleton by bone name. RPM-skeleton clips bind directly.
   * Returns the names that bound. The CALLER gates this (a discovered avatar's
   * config.bodyAnim, else the humanoid auto-detect) — the RPM animation library
   * is licensed for use with RPM-compatible avatars.
   */
  async loadAnimations(clips: { name: string; url: string }[]): Promise<string[]> {
    if (!this.animRoot) return [];
    const loader = new GLTFLoader();
    this.mixer = new THREE.AnimationMixer(this.animRoot);
    // Names of nodes that actually exist, to drop tracks for bones this skeleton
    // lacks (e.g. Avaturn has no fingertip bones) — avoids noisy PropertyBinding
    // warnings while still animating every bone that's present.
    const nodeNames = new Set<string>();
    this.animRoot.traverse((o) => o.name && nodeNames.add(o.name));
    const loaded: string[] = [];
    for (const c of clips) {
      try {
        const gltf = await loader.loadAsync(c.url);
        const clip = gltf.animations[0];
        if (!clip) continue;
        // Keep only tracks whose bone exists, and drop ALL position tracks:
        // a standing anchor shouldn't translate, and a clip's hip-position track
        // applied to a differently-scaled skeleton (e.g. MPFB) would displace /
        // balloon the whole avatar. Rotation-only retargeting is robust.
        clip.tracks = clip.tracks.filter(
          (t) => nodeNames.has(t.name.split('.')[0]) && !t.name.endsWith('.position'),
        );
        const action = this.mixer.clipAction(clip, this.animRoot as THREE.Object3D);
        action.setLoop(THREE.LoopRepeat, Infinity);
        this.actions[c.name] = action;
        loaded.push(c.name);
      } catch {
        /* skip a clip that fails to load */
      }
    }
    // Rest in a natural standing pose instead of the skeleton's T-pose bind: start a
    // neutral idle clip as soon as one binds. Idle motion only layers breathing/sway on
    // top of the playing body clip, so without this the avatar holds its arms-wide bind.
    if (!this.currentClip) this.restToIdle(0);
    return loaded;
  }

  /** Crossfade to a named body clip (no-op if it isn't loaded). */
  playClip(name: string, fade = 0.3): void {
    const next = this.actions[name];
    if (!next || this.currentClip === name) return;
    const prev = this.actions[this.currentClip];
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (prev) prev.fadeOut(fade);
    this.currentClip = name;
    this.idleHoldT = 0; // re-settle the new pose before freezing (idle-motion off)
  }

  /** Idle breathing/sway. Off → the avatar settles into a still standing pose. */
  setIdleMotion(on: boolean): void {
    this.idleMotion = on;
    if (on) this.idleHoldT = 0;
  }

  get animationClips(): string[] {
    return Object.keys(this.actions);
  }

  /** Settle into a resting idle pose. Reuses the loader's idle → idle_calm → first-clip
   *  fallback — playClip is a no-op for a missing clip, so 'idle' alone isn't safe (a
   *  partial asset load could leave only talk clips). No-op if no body clip is loaded. */
  restToIdle(fade = 0.3): void {
    const rest = this.actions['idle'] ? 'idle' : this.actions['idle_calm'] ? 'idle_calm' : Object.keys(this.actions)[0];
    if (rest) this.playClip(rest, fade);
  }

  setEmotion(name: EmotionName, intensity = 1): void {
    this.emotion = name;
    this.emotionIntensity = intensity;
  }

  // Per-avatar lip-sync tuning (how much the lips move). Set from the avatar's
  // config.json; calibrated live from the editor's Lip-sync panel.
  private lip = { gain: 1, jaw: 1, wide: 1, round: 1 };
  setLipsync(cfg: Partial<{ gain: number; jaw: number; wide: number; round: number }>): void {
    this.lip = { ...this.lip, ...cfg };
  }

  /** Called at audio rate by the lipsync driver. Scaled by the avatar's config. */
  setMouth(cue: MouthCue): void {
    const g = this.lip.gain;
    this.mouthTarget = {
      jawOpen: clamp01(cue.jawOpen * g * this.lip.jaw),
      mouthWide: clamp01(cue.mouthWide * g * this.lip.wide),
      mouthRound: clamp01(cue.mouthRound * g * this.lip.round),
      mouthClose: cue.mouthClose,
    };
    // Derive "speaking" from the RAW cue, not the calibrated one — otherwise a low
    // lip-sync gain (or 0) would falsely read as silent and freeze body animation.
    this.speaking = cue.jawOpen + cue.mouthWide + cue.mouthRound > 0.04;
  }

  setSilent(): void {
    this.mouthTarget = { ...SILENT };
    this.speaking = false;
  }

  /**
   * Drive the full face from an ARKit name→weight frame (Audio2Face-3D). Pass
   * null to return to channel-based (amplitude/viseme) lip-sync.
   */
  setNamedFace(weights: Record<string, number> | null): void {
    this.namedFace = weights;
    this.speaking = weights !== null;
  }

  get supportsNamedFace(): boolean {
    return typeof this.rig.applyNamed === 'function';
  }

  /** Make the eyes look at a world point (e.g. the camera). null → look ahead. */
  setGazeTarget(target: THREE.Vector3 | null): void {
    this.gazeTarget = target;
  }

  // Drive ARKit eyeLook* morphs so the gaze tracks `gazeTarget`, smoothed.
  private applyGaze(dt: number): void {
    if (!this.rig.applyExtra) return;
    const target: Record<string, number> = {};
    for (const e of EYE_LOOK) target[e] = 0;

    if (this.gazeTarget) {
      const eyeWorld = _v1.copy(this.headCenter).add(this.group.position);
      const dir = _v2.subVectors(this.gazeTarget, eyeWorld).normalize();
      this.group.getWorldQuaternion(_q);
      const fwd = _fwd.set(0, 0, 1).applyQuaternion(_q);
      const up = _up.set(0, 1, 0).applyQuaternion(_q);
      const right = _right.set(1, 0, 0).applyQuaternion(_q);
      const f = dir.dot(fwd);
      if (f > 0.05) {
        const hA = Math.atan2(dir.dot(right), f);
        const vA = Math.atan2(dir.dot(up), f);
        const maxA = 0.5; // ~28° max eye travel
        const hw = Math.min(1, Math.abs(hA) / maxA) * 0.85;
        const vw = Math.min(1, Math.abs(vA) / maxA) * 0.85;
        if (hA > 0) {
          target.eyeLookInLeft = hw;
          target.eyeLookOutRight = hw;
        } else {
          target.eyeLookOutLeft = hw;
          target.eyeLookInRight = hw;
        }
        if (vA > 0) {
          target.eyeLookUpLeft = vw;
          target.eyeLookUpRight = vw;
        } else {
          target.eyeLookDownLeft = vw;
          target.eyeLookDownRight = vw;
        }
      }
    }

    const rate = 1 - Math.exp(-dt / 0.12);
    for (const e of EYE_LOOK) {
      const cur = this.gazeWeights[e] ?? 0;
      this.gazeWeights[e] = cur + (target[e] - cur) * rate;
    }
    this.rig.applyExtra(this.gazeWeights);
  }

  update(dt: number): void {
    // Advance skeletal body animation. With idle motion OFF, let the current clip
    // settle into a still pose then freeze it (no breathing/weight-shift) — but
    // always animate while speaking so gestures play.
    let adv = dt;
    if (!this.idleMotion && !this.speaking) {
      if (this.idleHoldT < 1.6) this.idleHoldT += dt;
      else adv = 0; // hold the settled pose
    }
    this.mixer?.update(adv);

    // A2F-3D / ARKit full-face path: the timeline already carries jaw, visemes,
    // brows, blinks and emotion, so apply it directly and only add idle motion.
    if (this.namedFace && this.rig.applyNamed) {
      this.updateIdle(dt);
      this.rig.applyNamed(this.namedFace);
      return;
    }

    // Smooth mouth toward target. Jaw attacks fast, releases a touch slower so
    // closures read crisply but don't chatter.
    const attack = 1 - Math.exp(-dt / 0.035);
    const release = 1 - Math.exp(-dt / 0.06);
    this.current.jawOpen = approach(this.current.jawOpen, this.mouthTarget.jawOpen, attack, release);
    this.current.mouthWide = approach(this.current.mouthWide, this.mouthTarget.mouthWide, attack, release);
    this.current.mouthRound = approach(this.current.mouthRound, this.mouthTarget.mouthRound, attack, release);
    this.current.mouthClose = approach(this.current.mouthClose, this.mouthTarget.mouthClose, attack, release);

    // Emotion blends in slowly.
    const bias = emotionBias(this.emotion, this.emotionIntensity);
    const eRate = 1 - Math.exp(-dt / 0.25);
    this.current.smile += (bias.smile - this.current.smile) * eRate;
    this.current.frown += (bias.frown - this.current.frown) * eRate;
    this.current.browRaise += (bias.browRaise - this.current.browRaise) * eRate;

    this.updateBlink(dt);
    this.updateIdle(dt);

    this.rig.apply(this.current);
    this.applyGaze(dt); // eyeLook morphs layered on top (no zeroing)

    // Smoothly approach the director turn angle (Y rotation of the whole avatar).
    const cur = this.group.rotation.y;
    this.group.rotation.y = cur + (this.turnTarget - cur) * (1 - Math.exp(-dt / 0.35));
  }

  private updateBlink(dt: number): void {
    if (this.blinkPhase < 0) {
      this.blinkClock += dt;
      if (this.blinkClock >= this.nextBlinkAt) {
        this.blinkPhase = 0;
        this.blinkClock = 0;
      }
    } else {
      this.blinkPhase += dt / 0.13; // ~130ms blink
      if (this.blinkPhase >= 1) {
        this.blinkPhase = -1;
        this.nextBlinkAt = 2 + Math.random() * 3.5;
      }
    }
    // Triangle curve: 0→1→0 closure.
    this.current.blink = this.blinkPhase < 0 ? 0 : 1 - Math.abs(this.blinkPhase * 2 - 1);
  }

  private updateIdle(dt: number): void {
    if (!this.idleMotion) {
      // Hold perfectly still (skeletal idle clip is frozen separately in update()).
      this.motion.position.y = 0;
      this.motion.rotation.set(0, 0, 0);
      return;
    }
    this.idleClock += dt;
    const t = this.idleClock;
    // Subtle breathing + sway on the inner group (so the X/Y/Z offset on the
    // outer group is preserved).
    const amp = this.speaking ? 1.2 : 1;
    this.motion.position.y = Math.sin(t * 1.6) * 0.005 * amp;
    this.motion.rotation.y = Math.sin(t * 0.5) * 0.02 * amp + Math.sin(t * 0.23) * 0.01;
    this.motion.rotation.x = Math.sin(t * 0.7) * 0.008 * amp;
  }
}

function approach(cur: number, target: number, attack: number, release: number): number {
  const rate = target > cur ? attack : release;
  return cur + (target - cur) * rate;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The mesh carrying the most morph targets is the face. */
function faceMeshOf(root: THREE.Object3D): THREE.Mesh | null {
  let best: THREE.Mesh | null = null;
  let bestCount = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const n = m.isMesh ? Object.keys(m.morphTargetDictionary ?? {}).length : 0;
    if (n > bestCount) {
      bestCount = n;
      best = m;
    }
  });
  return best;
}

// Scale + position any avatar to a sensible stage size and return the world-space
// head center for camera framing. `faceMesh` (the morph-bearing mesh) gives an
// exact head when present; otherwise `headBone` locates the head; otherwise we
// estimate from the bounding box.
function fitAvatar(root: THREE.Object3D, faceMesh: THREE.Mesh | null): { center: THREE.Vector3; height: number } {
  root.traverse((o) => {
    o.castShadow = true;
    o.frustumCulled = false;
  });
  const headBone = findHeadBone(root);

  const whole = new THREE.Box3().setFromObject(root);
  // Box3.setFromObject ignores skinning, so a skinned mesh whose geometry is
  // authored small but scaled up by its armature (MakeHuman/MPFB) reports a tiny
  // box → fitAvatar would scale it up enormously. Expand the box by the skeleton's
  // bone world positions so the measured height matches the actual rendered figure.
  root.updateWorldMatrix(true, true);
  const _bp = new THREE.Vector3();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) whole.expandByPoint(o.getWorldPosition(_bp));
  });
  const wholeSize = new THREE.Vector3();
  whole.getSize(wholeSize);

  // Head-only when an unskinned morph mesh dominates the asset (a face scan like
  // facecap). Skinned full-body avatars (RPM) report a tiny/degenerate face-mesh
  // box, so we never treat those as head-only.
  let headOnly = false;
  if (faceMesh && !(faceMesh as THREE.SkinnedMesh).isSkinnedMesh) {
    const fb = new THREE.Box3().setFromObject(faceMesh);
    const fs = new THREE.Vector3();
    fb.getSize(fs);
    headOnly = wholeSize.y > 0 && fs.y / wholeSize.y > 0.6;
    if (headOnly) {
      const fc = new THREE.Vector3();
      fb.getCenter(fc);
      const scale = fs.y > 0 ? 0.24 / fs.y : 1;
      root.scale.setScalar(scale);
      root.position.set(-fc.x * scale, 1.5 - fc.y * scale, -fc.z * scale);
    }
  }

  if (!headOnly) {
    // Full figure: ~1.7m tall, feet on the floor.
    const scale = wholeSize.y > 0 ? 1.7 / wholeSize.y : 1;
    root.scale.setScalar(scale);
    const wc = new THREE.Vector3();
    whole.getCenter(wc);
    root.position.set(-wc.x * scale, -whole.min.y * scale, -wc.z * scale);
  }

  // Resolve the head center + height in world space after the transform.
  // Bone-expanded again (same reason as above) so the figure height is correct
  // for skinned meshes whose un-posed geometry box understates the real size.
  root.updateWorldMatrix(true, true);
  const finalWhole = new THREE.Box3().setFromObject(root);
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) finalWhole.expandByPoint(o.getWorldPosition(_bp));
  });
  const finalWholeH = finalWhole.max.y - finalWhole.min.y;
  const hc = new THREE.Vector3();
  let height = 0;

  // Box estimate: head ~ top of the figure. Used when there's no head bone, or
  // when the head bone is bogus (e.g. MakeHuman/MPFB armatures whose bone scale
  // doesn't match the mesh, putting the "head" bone metres above the body).
  const boxEstimate = (): void => {
    hc.set(
      (finalWhole.min.x + finalWhole.max.x) / 2,
      finalWhole.min.y + finalWholeH * 0.9,
      (finalWhole.min.z + finalWhole.max.z) / 2,
    );
    height = finalWholeH * 0.13;
  };

  if (headOnly && faceMesh) {
    const fb = new THREE.Box3().setFromObject(faceMesh);
    fb.getCenter(hc);
    height = fb.max.y - fb.min.y;
  } else if (headBone) {
    const hb = new THREE.Vector3();
    headBone.getWorldPosition(hb);
    // Trust the bone only if it sits in the upper part of the figure (a real
    // head). A mis-named/mis-placed "head" bone low in the body → box estimate.
    // (finalWhole is bone-expanded, so an absolute-extent check would be a no-op.)
    if (hb.y > finalWhole.min.y + finalWholeH * 0.55) {
      hc.copy(hb);
      hc.y += finalWholeH * 0.045; // bone pivot is low in the head; raise to eyes
      height = finalWholeH * 0.13; // a human head is ~13% of standing height
    } else {
      boxEstimate();
    }
  } else {
    boxEstimate();
  }
  return { center: hc, height: Math.max(height, 0.05) };
}

// Find a head bone by name, ignoring the RPM/Mixamo "HeadTop_End" tip marker.
function findHeadBone(root: THREE.Object3D): THREE.Object3D | null {
  let exact: THREE.Object3D | null = null;
  let loose: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!((o as THREE.Bone).isBone || /bone/i.test(o.type))) return;
    if (/top|end|tip/i.test(o.name)) return;
    if (/(^|[:_])head$/i.test(o.name)) exact ??= o;
    else if (/head/i.test(o.name)) loose ??= o;
  });
  return exact ?? loose;
}
