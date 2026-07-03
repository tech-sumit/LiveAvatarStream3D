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
import { planPath } from '@las/performer-core';
import type { Vec3 } from '@las/performer-core';
import { aimArm, gazeMorph, countFingers, makeFingerCurls, yawTowardVec } from '../scene/coreAdapter.js';

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
// reused gaze-morph result (performer-core aimEye → normalized morph weights + signs)
const _gaze = { hw: 0, vw: 0, hPos: false, vPos: false };

// scratch objects for point-aiming (avoid per-frame allocation). The orthonormal-basis
// math that built the desired local quaternion now lives in performer-core's aimLimb
// (reproduced to the bit, pinned by its Phase-2 regression fixture); the controller keeps
// only the shoulder lookup, the world aim direction, and the parent world quaternion it
// feeds in, plus the two output quats aimLimb writes (upper arm + forearm).
const _aimTarget = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _aimParentWorld = new THREE.Quaternion();
const _aimUpper = new THREE.Quaternion();
const _aimFore = new THREE.Quaternion();
const _aimShoulder = new THREE.Vector3();

// One-shot gestures blend in at a REDUCED weight so they read as understated and
// stable while the talking base still shows through — full weight (1.0) made them
// over-animated. Tune here.
const GESTURE_WEIGHT = 0.65;

// Point-aim apply-layer config (the basis math itself lives in performer-core aimLimb).
// The slerp weights are carried into aimLimb's opts (and used by the controller's apply);
// the ramp/hold are gesture-lifecycle timing, not solver math, so they stay here.
const POINT_AIM_WEIGHT = 0.85; // slerp weight toward the aimed upper-arm quat
const POINT_FOREARM_WEIGHT = 0.8; // straighten the forearm for a clean extended point
const POINT_AIM_TAU = 0.2; // seconds; smoothing time constant toward the aim
const POINT_HOLD = 2.2; // seconds the point is held before it releases back to talking
const POINT_AIM_OPTS = { weight: POINT_AIM_WEIGHT, foreArmWeight: POINT_FOREARM_WEIGHT };

// "Stand by the screen" walk: the anchor walks from centre stage to a mark beside the
// screen to present, then walks back. The per-frame travel facing comes from
// performer-core turnToward (yawTowardVec); planPath supplies the walk speed default
// (1.2 m/s) and the arrival facing. MOVE_ARRIVE is the controller's stop tolerance.
const MOVE_ARRIVE = 0.08; // metres — close enough; stop + face the arrival facing
const _moveStep = new THREE.Vector3();
const _movePos: Vec3 = [0, 0, 0]; // reused current-position tuple (no per-frame alloc)

// Floor mark beside the stand-mounted screen the anchor walks to when presenting a point
// gesture (was pushed in per-avatar via setScreenStation; it equalled this default, so it
// is now Stage-style data here). In a later phase this comes from the Score's Stage marks.
const SCREEN_MARK: Vec3 = [0.75, 0, 0.25];

// Finger-counting: the per-joint curl constants + 1→2→3 timing now live in performer-core
// fingerCount (FINGER_CURL = [-1.0,-1.45,-1.2], COUNT_PHASE = 0.75, pinned by its Phase-2
// fixture). The controller keeps the release time (apply-layer lifecycle) + the per-frame
// smoothing time constant toward the count pose.
const COUNT_TOTAL = 3.4; // seconds before releasing the fingers back to the clip
const COUNT_SMOOTH_TAU = 0.12; // seconds; smoothing toward the counted finger pose

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
  private _idleMotion = false; // default: avatar holds still (no breathing/sway)
  private idleHoldT = 0; // time spent settling the current pose before freezing

  // Renderer is needed for KTX2 transcoder support detection.
  private renderer: THREE.WebGLRenderer | null = null;

  // Skeletal body animation (Ready Player Me avatars only — license-gated).
  isReadyPlayerMe = false;
  private animRoot: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private currentClip = '';

  // Full-body locomotion clips (walk/turn) loaded into the SAME mixer as `actions`.
  // A separate map so the walk controller can enumerate them without picking up
  // talk/gesture clips, but they live on one mixer so crossfades blend correctly.
  private locoActions: Record<string, THREE.AnimationAction> = {};

  // Point-aiming: when a point gesture is active AND a world-space target is set,
  // the LEFT arm (the one on the screen's side — the screen sits to the anchor's left,
  // camera-right) is rotated to aim the hand at the target, so nothing crosses the
  // chest. `pointing` gates the effect; `pointAimAmount` ramps it in/out (0..1);
  // `pointT` holds the point for a beat then releases it.
  private pointTarget: THREE.Vector3 | null = null;
  private pointing = false;
  private pointAimAmount = 0;
  private pointT = 0;

  // Locomotion `move`: the anchor walks to a floor mark (centre stage "home" ↔ a mark
  // beside the screen). `moveTarget` is where it's currently headed (a plain Vec3 floor
  // mark); `moveHome` is the centre it returns to; `moving` is true while in motion (so we
  // stop + face the arrival facing on arrival); `moveArriveFacing` is the yaw to settle to
  // on arrival (planPath.arriveFacing; default 0 = face the camera).
  private moveHome: Vec3 = [0, 0, 0];
  private moveTarget: Vec3 = [0, 0, 0];
  private moving = false;
  private moveArriveFacing = 0;
  private moveSpeed = 1.2; // m/s walk speed (planPath default; STATION_SPEED was 1.2)

  // Procedural finger-counting: the 'count' gesture poses the right hand 1 → 2 → 3
  // fingers (index, then +middle, then +ring) while the clip raises the arm. We curl
  // the unused fingers into the palm about each joint's local X axis (negative = fold,
  // verified on the rig). `fingerExt[f]` (0 curled .. 1 extended) is lerped per finger
  // so the count reads as a stable, deliberate 1-2-3 instead of a snap.
  private counting = false;
  private countT = 0;
  private fingerExt = [0, 0, 0, 0]; // index, middle, ring, pinky (0 curled .. 1 extended)
  private fingerBones: THREE.Object3D[][] | null = null; // [finger][joint]
  private fingerTarget = makeFingerCurls(); // reused fingerCount out-param (no per-frame alloc)

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
    this.locoActions = {};
    this.currentClip = '';
    this.pointing = false;
    this.pointAimAmount = 0;
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
  async loadAnimations(clips: { name: string; url: string; fallback?: string }[]): Promise<string[]> {
    if (!this.animRoot) return [];
    this.mixer = new THREE.AnimationMixer(this.animRoot);
    const loaded = await this.bindClips(clips, this.actions);
    // Rest in a natural standing pose instead of the skeleton's T-pose bind: start a
    // neutral idle clip as soon as one binds. Idle motion only layers breathing/sway on
    // top of the playing body clip, so without this the avatar holds its arms-wide bind.
    if (!this.currentClip) this.restToIdle(0);
    return loaded;
  }

  /**
   * Load full-body locomotion clips (walk / walk_back / turn_left / turn_180 …)
   * into the SAME mixer as `actions`, using the identical track-binding logic
   * (drop `.position` tracks, bind by bone name, LoopRepeat). Stored in a parallel
   * `locoActions` map so a walk controller can drive them independently of talk /
   * gesture clips. Returns the names that bound. Does NOT move the avatar group —
   * the walk controller owns root translation.
   */
  async loadLocomotion(clips: { name: string; url: string; fallback?: string }[]): Promise<string[]> {
    if (!this.animRoot) return [];
    // Reuse the existing mixer if animations are already loaded; otherwise create one
    // so locomotion can be loaded standalone.
    if (!this.mixer) this.mixer = new THREE.AnimationMixer(this.animRoot);
    return this.bindClips(clips, this.locoActions);
  }

  /**
   * Shared track-binding loop: load each clip's first AnimationClip, keep only
   * rotation tracks whose bone exists on this skeleton, and register the bound
   * AnimationAction (LoopRepeat) into `into`. Rotation-only retargeting is robust;
   * dropping `.position` keeps a clip's hip translation from displacing the avatar.
   */
  private async bindClips(
    clips: { name: string; url: string; fallback?: string }[],
    into: Record<string, THREE.AnimationAction>,
  ): Promise<string[]> {
    if (!this.animRoot || !this.mixer) return [];
    const loader = new GLTFLoader();
    // Names of nodes that actually exist, to drop tracks for bones this skeleton
    // lacks (e.g. Avaturn has no fingertip bones) — avoids noisy PropertyBinding
    // warnings while still animating every bone that's present.
    const nodeNames = new Set<string>();
    this.animRoot.traverse((o) => o.name && nodeNames.add(o.name));
    const loaded: string[] = [];
    for (const c of clips) {
      try {
        // Prefer the per-avatar clip (its own folder); fall back to the shared set.
        let gltf;
        try {
          gltf = await loader.loadAsync(c.url);
        } catch (err) {
          if (!c.fallback) throw err;
          gltf = await loader.loadAsync(c.fallback);
        }
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
        into[c.name] = action;
        loaded.push(c.name);
      } catch {
        /* skip a clip that fails to load */
      }
    }
    return loaded;
  }

  /** Crossfade to a named locomotion clip (looping). No-op if it isn't loaded. */
  playLocomotion(name: string, fade = 0.25): void {
    const next = this.locoActions[name];
    if (!next || !this.mixer || this.currentClip === name) return;
    const prev = this.actions[this.currentClip] ?? this.locoActions[this.currentClip];
    next.reset().setLoop(THREE.LoopRepeat, Infinity).setEffectiveWeight(1).fadeIn(fade).play();
    if (prev && prev !== next) prev.fadeOut(fade);
    this.currentClip = name;
    this.idleHoldT = 0;
  }

  /** Crossfade back from locomotion into the resting idle pose. */
  stopLocomotion(fade = 0.3): void {
    // Only the active clip matters; restToIdle crossfades out whatever is playing.
    this.restToIdle(fade);
  }

  /** Crossfade to a named body clip (no-op if it isn't loaded). */
  playClip(name: string, fade = 0.3): void {
    const next = this.actions[name];
    if (!next || this.currentClip === name) return;
    // The outgoing clip may be a talk/gesture clip OR a locomotion clip.
    const prev = this.actions[this.currentClip] ?? this.locoActions[this.currentClip];
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (prev) prev.fadeOut(fade);
    this.currentClip = name;
    this.idleHoldT = 0; // re-settle the new pose before freezing (idle-motion off)
  }

  /** Pending "settle back to talking" handler queued after a one-shot gesture. */
  private gestureReturn: ((e: { type: string; action?: unknown }) => void) | null = null;

  /**
   * Play a dedicated gesture clip ONCE over the talking motion, then crossfade
   * back into `baseClip` when it finishes — so a wave waves once and returns to
   * talking instead of looping forever. Falls back to just playing the base clip
   * if the gesture clip isn't loaded (e.g. fetch-animations.sh wasn't run).
   */
  playGesture(gestureName: string, baseClip: string, fade = 0.25): void {
    // Screen reference: instead of pointing, the anchor WALKS over to present from beside
    // the screen. Keep the talking base — the walk + facing are driven by `move` (planPath
    // + turnToward), settling to face the camera (arriveFacing 0) on arrival.
    if (/(^|_)point|screen/i.test(gestureName)) {
      this.playClip(baseClip, fade);
      this.pointing = false;
      this.counting = false;
      this.move(SCREEN_MARK);
      return;
    }
    // Any other gesture: if the anchor is parked by the screen, walk it back to centre.
    this.move(this.moveHome);
    const g = this.actions[gestureName];
    if (!g || !this.mixer) {
      this.playClip(baseClip, fade);
      return;
    }
    // Cancel a previous gesture's pending return so it can't yank us off this one.
    if (this.gestureReturn) {
      this.mixer.removeEventListener('finished', this.gestureReturn);
      this.gestureReturn = null;
    }
    const prev = this.actions[this.currentClip] ?? this.locoActions[this.currentClip];
    g.reset();
    g.setLoop(THREE.LoopOnce, 1);
    g.clampWhenFinished = true;
    // Blend the one-shot gesture in at a REDUCED weight so it reads but stays
    // understated and stable — the talking base shows through. (Was 1.0, which
    // looked over-animated.)
    g.setEffectiveWeight(GESTURE_WEIGHT).fadeIn(fade).play();
    if (prev && prev !== g) prev.fadeOut(fade);
    this.currentClip = gestureName;
    this.idleHoldT = 0;
    // A non-point gesture: stop any point-aim and let the body face front again.
    this.pointing = false;
    // Start procedural finger-counting if this is the count gesture.
    this.counting = /count/i.test(gestureName);
    if (this.counting) {
      this.countT = 0;
      this.fingerExt = [0, 0, 0, 0];
    }
    const onFinished = (e: { type: string; action?: unknown }): void => {
      if (e.action !== g) return;
      this.mixer?.removeEventListener('finished', onFinished);
      this.gestureReturn = null;
      this.pointing = false; // point gesture finished → stop aiming, ramp back out
      this.counting = false; // release the counted fingers back to the clip/idle
      this.playClip(baseClip, 0.35);
    };
    this.gestureReturn = onFinished;
    this.mixer.addEventListener('finished', onFinished);
  }

  /**
   * Set the world-space point target the right arm aims at while a point gesture
   * plays. null clears it. Aiming is gated on `this.pointing` (set true only when
   * playGesture runs a point clip), so a stale target never moves the arm outside
   * a point gesture.
   */
  setPointTarget(target: THREE.Vector3 | null): void {
    this.pointTarget = target ? target.clone() : null;
  }

  /**
   * Walk the anchor to a floor mark (the `move` verb). `planPath` resolves the walk speed
   * (default 1.2 m/s) and the arrival facing (yaw to settle to on arrival — `Mark.facing`;
   * default 0 = face the camera); the per-frame travel + facing run in `updateMove`. The
   * Y of `target` is ignored (floor move on XZ). Replaces goToScreen/returnToCenter and the
   * former station machine — one entry point for all walk-to-mark locomotion.
   */
  move(target: Vec3, opts?: { gait?: 'walk' | 'stride'; speed?: number; arriveFacing?: number }): void {
    const from: Vec3 = [this.group.position.x, this.group.position.y, this.group.position.z];
    const plan = planPath(from, [target[0], 0, target[2]], opts);
    this.moveTarget = [plan.samples[plan.samples.length - 1]?.pos[0] ?? target[0], 0, plan.samples[plan.samples.length - 1]?.pos[2] ?? target[2]];
    this.moveSpeed = plan.speed;
    this.moveArriveFacing = plan.arriveFacing ?? 0;
  }

  /** The user hand-placed the anchor (3D move gizmo): adopt that spot as the new home
   *  (centre) so it returns there — not to the original spawn — and isn't auto-walked off
   *  it. Parks it there immediately (no walk). */
  setStageHome(pos: THREE.Vector3): void {
    this.moveHome = [pos.x, pos.y, pos.z];
    this.moveTarget = [pos.x, 0, pos.z];
    this.moving = false;
  }

  /** The persistable hand-placement (the stage home — walks return here). NEVER a mid-walk
   *  transient, unlike group.position. */
  get stageHomePos(): [number, number, number] {
    return [this.moveHome[0], this.moveHome[1], this.moveHome[2]];
  }
  get isMoving(): boolean {
    return this.moving;
  }

  /**
   * Drive the anchor toward its `move` target each frame. While more than MOVE_ARRIVE from
   * the target it walks toward it (faces the travel direction via performer-core turnToward,
   * plays the walk clip, advances the group position at moveSpeed); on arrival it snaps to
   * the mark, settles to the arrival facing, and idles. Runs every frame; a no-op once
   * parked at the current target. (Reproduces the former updateStation exactly: turnToward
   * is the same atan2 travel facing; arriveFacing 0 is the former "face the camera" datum.)
   */
  private updateMove(dt: number): void {
    const pos = this.group.position;
    _moveStep.set(this.moveTarget[0] - pos.x, 0, this.moveTarget[2] - pos.z);
    const dist = _moveStep.length();
    if (dist > MOVE_ARRIVE) {
      _moveStep.divideScalar(dist); // normalise
      _movePos[0] = pos.x;
      _movePos[1] = pos.y;
      _movePos[2] = pos.z;
      this.turnTarget = yawTowardVec(_movePos, this.moveTarget); // face the way we're walking
      const step = Math.min(this.moveSpeed * dt, dist);
      pos.x += _moveStep.x * step;
      pos.z += _moveStep.z * step;
      this.playLocomotion('walk');
      this.moving = true;
    } else if (this.moving) {
      pos.x = this.moveTarget[0];
      pos.z = this.moveTarget[2];
      this.turnTarget = this.moveArriveFacing; // arrived → settle to the arrival facing
      this.stopLocomotion();
      this.moving = false;
    }
  }

  /** Idle breathing/sway. Off → the avatar settles into a still standing pose. */
  setIdleMotion(on: boolean): void {
    this._idleMotion = on;
    if (on) this.idleHoldT = 0;
  }
  /** Whether the body is "lively" (idle sway + the full talk-gesticulation pool). Off → a
   *  calm anchor: no idle sway AND the speaking base is held to the calm talk clips. */
  get idleMotion(): boolean {
    return this._idleMotion;
  }

  get animationClips(): string[] {
    return Object.keys(this.actions);
  }

  /** Names of the loaded full-body locomotion clips (walk/turn), for the walk controller. */
  get locomotionClips(): string[] {
    return Object.keys(this.locoActions);
  }

  /** Settle into a resting idle pose. Reuses the loader's idle → idle_calm → first-clip
   *  fallback — playClip is a no-op for a missing clip, so 'idle' alone isn't safe (a
   *  partial asset load could leave only talk clips). No-op if no body clip is loaded. */
  restToIdle(fade = 0.3): void {
    const rest = this.actions['idle'] ? 'idle' : this.actions['idle_calm'] ? 'idle_calm' : Object.keys(this.actions)[0];
    if (rest) this.playClip(rest, fade);
  }

  /**
   * Aim the arm at the stored world-space point target. The arm on the target's side is
   * auto-selected by performer-core `aimLimb` (the screen sits camera-right, so a screen
   * point picks the LEFT arm — nothing crosses the chest), which also builds the desired
   * parent-space local quaternion (the +Y-down-the-bone basis math, reproduced to the bit
   * from this code and pinned by its Phase-2 fixture). The controller does only the bone
   * lookup + the smoothed, ramped slerp. Only engages while a point gesture is active
   * (`this.pointing`) AND a target is set; otherwise it ramps out so the talking base
   * resumes. Allocation-free (reused scratch + aimLimb's plain tuples).
   */
  private applyPointing(dt: number): void {
    // Hold the point for a beat, then release it (face front, drop the arm).
    if (this.pointing) {
      this.pointT += dt;
      if (this.pointT > POINT_HOLD) {
        this.pointing = false;
        this.setTurn(0);
      }
    }
    // Ramp the aim amount toward 1 while pointing, toward 0 otherwise.
    const want = this.pointing && this.pointTarget ? 1 : 0;
    const rate = 1 - Math.exp(-dt / POINT_AIM_TAU);
    this.pointAimAmount += (want - this.pointAimAmount) * rate;
    if (this.pointAimAmount < 0.001 || !this.animRoot || !this.pointTarget) return;

    // World-space aim direction (shoulder → target). Use the left shoulder as the origin
    // (as the prior hardcoded-LeftArm path did); the side is the arm that aims from this
    // direction's azimuth — for a camera-right (+X) screen target that is the LEFT arm,
    // identical to before. (Matches aimLimb's `auto`: targetDir.x >= 0 → left.)
    const ref = this.animRoot.getObjectByName('LeftArm');
    if (!ref) return;
    ref.getWorldPosition(_aimShoulder);
    _aimTarget.copy(this.pointTarget);
    _aimDir.subVectors(_aimTarget, _aimShoulder);
    if (_aimDir.lengthSq() < 1e-8) return;
    _aimDir.normalize();

    const side: 'left' | 'right' = _aimDir.x >= 0 ? 'left' : 'right';
    const arm = this.animRoot.getObjectByName(side === 'left' ? 'LeftArm' : 'RightArm');
    if (!arm || !arm.parent) return;
    // Build the parent-space upper-arm + forearm targets via aimLimb, reading the selected
    // arm's parent world quaternion (its parent space). Side passed explicitly so the bone
    // lookup and solver agree exactly.
    arm.parent.getWorldQuaternion(_aimParentWorld);
    aimArm(_aimDir, _aimParentWorld, side, _aimUpper, _aimFore, POINT_AIM_OPTS);

    // Slerp from the clip's current local rotation toward the aim by a capped, ramped
    // weight — understated and stable, never overriding the clip entirely.
    arm.quaternion.slerp(_aimUpper, POINT_AIM_WEIGHT * this.pointAimAmount);

    // Straighten the forearm (aimLimb returns an identity forearm target — a plain point,
    // no wrist/forearm roll, so nothing twists).
    const fore = this.animRoot.getObjectByName(side === 'left' ? 'LeftForeArm' : 'RightForeArm');
    if (fore) fore.quaternion.slerp(_aimFore, POINT_FOREARM_WEIGHT * this.pointAimAmount);
  }

  /**
   * Procedurally pose the right hand to count 1 → 2 → 3 over the count gesture.
   * Runs after the mixer so it overrides whatever the count clip does to the fingers.
   * Each non-counted finger curls into the palm (local X, negative); `fingerExt` is
   * lerped so transitions between numbers are smooth and the held number is stable.
   */
  private applyCounting(dt: number): void {
    if (!this.counting) return;
    this.countT += dt;
    if (this.countT > COUNT_TOTAL) {
      this.counting = false; // hand back to the clip/idle
      return;
    }
    if (!this.fingerBones) this.cacheFingerBones();
    if (!this.fingerBones) return;

    // performer-core computes the 1→2→3 ramp + the per-joint target curl (curl[j]·(1-ext),
    // ext∈{0,1}) — the same FINGER_CURL/COUNT_PHASE numbers, now in fingerCount. We recover
    // the per-finger up/down binary + the curl constants from its output, then keep the
    // controller's per-finger smoothing (fingerExt) + apply, exactly as before.
    const curls = countFingers(3, this.countT, this.fingerTarget).curls;
    // Pinky (finger 3) is always down → its row is the curl constants curl[j].
    const curlConst = curls[3] ?? [];
    const k = 1 - Math.exp(-dt / COUNT_SMOOTH_TAU); // smoothing toward the target
    for (let f = 0; f < 4; f++) {
      const row = curls[f] ?? [];
      // A finger is "up" iff its target curls are ~0 (extended); else it folds.
      const up = (row[0] ?? 0) === 0 ? 1 : 0;
      this.fingerExt[f] += (up - this.fingerExt[f]) * k;
      const ext = this.fingerExt[f];
      const joints = this.fingerBones[f];
      if (!joints) continue;
      for (let j = 0; j < joints.length; j++) {
        const bone = joints[j];
        if (bone) bone.rotation.x = (curlConst[j] ?? 0) * (1 - ext);
      }
    }
  }

  private cacheFingerBones(): void {
    if (!this.animRoot) return;
    const fingers = ['Index', 'Middle', 'Ring', 'Pinky'];
    const bones: THREE.Object3D[][] = fingers.map((name) => {
      const joints: THREE.Object3D[] = [];
      for (let j = 1; j <= 3; j++) {
        const b = this.animRoot!.getObjectByName(`RightHand${name}${j}`);
        if (b) joints.push(b);
      }
      return joints;
    });
    this.fingerBones = bones.every((j) => j.length === 3) ? bones : null;
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
      // performer-core aimEye applies the same front-gate (z>0.05), ±maxAngle clamp and
      // weight (the former maxA 0.5 / 0.85 literals); gazeMorph hands back the normalized
      // horizontal/vertical morph weights + their signs. The InLeft/OutRight cross-wiring
      // below is the avatar's rig binding and stays here.
      gazeMorph(dir.dot(right), dir.dot(up), dir.dot(fwd), _gaze);
      const { hw, vw } = _gaze;
      if (_gaze.hPos) {
        target.eyeLookInLeft = hw;
        target.eyeLookOutRight = hw;
      } else {
        target.eyeLookOutLeft = hw;
        target.eyeLookInRight = hw;
      }
      if (_gaze.vPos) {
        target.eyeLookUpLeft = vw;
        target.eyeLookUpRight = vw;
      } else {
        target.eyeLookDownLeft = vw;
        target.eyeLookDownRight = vw;
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
    // Walk toward the current move target (centre ↔ beside the screen) before posing.
    this.updateMove(dt);
    // Advance skeletal body animation. With idle motion OFF, let the current clip
    // settle into a still pose then freeze it (no breathing/weight-shift) — but
    // always animate while speaking, or while walking to a mark, so the legs move.
    let adv = dt;
    if (!this._idleMotion && !this.speaking && !this.moving) {
      if (this.idleHoldT < 1.6) this.idleHoldT += dt;
      else adv = 0; // hold the settled pose
    }
    this.mixer?.update(adv);
    // Aim the right arm at the point target (only during a point gesture). Runs
    // AFTER the mixer so it overrides the clip's arm pose for that frame.
    this.applyPointing(dt);
    // Pose the right-hand fingers for the count gesture (also after the mixer).
    this.applyCounting(dt);

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
    if (!this._idleMotion) {
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
