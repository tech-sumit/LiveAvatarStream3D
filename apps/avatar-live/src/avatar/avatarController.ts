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

export class AvatarController {
  readonly group = new THREE.Group();
  headCenter = new THREE.Vector3(0, 1.5, 0);
  headHeight = 0.42; // world-space head height, drives camera framing distance
  description = 'procedural head';

  private rig: FaceRig;
  private current: FaceChannels = zeroChannels();
  private mouthTarget: MouthCue = { ...SILENT };
  private namedFace: Record<string, number> | null = null;
  private emotion: EmotionName = 'neutral';
  private emotionIntensity = 1;
  private speaking = false;

  // blink state
  private nextBlinkAt = 1.5;
  private blinkClock = 0;
  private blinkPhase = -1; // -1 idle, else 0..1 progress

  // idle motion
  private idleClock = 0;

  // Renderer is needed for KTX2 transcoder support detection.
  private renderer: THREE.WebGLRenderer | null = null;

  constructor() {
    const head = createProceduralHead();
    // The procedural head is modeled at ~1m radius for easy authoring; scale it
    // to human proportions and lift it to standing eye height so the virtual
    // camera's framing distances (tuned for a real head) read correctly.
    head.group.scale.setScalar(0.18);
    head.group.position.y = 1.5;
    this.group.add(head.group);
    this.rig = head.rig;
    this.headCenter = new THREE.Vector3(0, 1.53, 0);
  }

  setRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
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
    this.group.clear();
    this.group.add(root);
    this.rig = rig;
    this.current = zeroChannels();
    this.headCenter = fit.center;
    this.headHeight = fit.height;
  }

  setEmotion(name: EmotionName, intensity = 1): void {
    this.emotion = name;
    this.emotionIntensity = intensity;
  }

  /** Called at audio rate by the lipsync driver. */
  setMouth(cue: MouthCue): void {
    this.mouthTarget = cue;
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

  update(dt: number): void {
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
    this.idleClock += dt;
    const t = this.idleClock;
    // Subtle breathing + sway; a little more alive while speaking.
    const amp = this.speaking ? 1.4 : 1;
    this.group.position.y = Math.sin(t * 1.6) * 0.006 * amp;
    this.group.rotation.y = Math.sin(t * 0.5) * 0.03 * amp + Math.sin(t * 0.23) * 0.015;
    this.group.rotation.x = Math.sin(t * 0.7) * 0.012 * amp;
  }
}

function approach(cur: number, target: number, attack: number, release: number): number {
  const rate = target > cur ? attack : release;
  return cur + (target - cur) * rate;
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
  root.updateWorldMatrix(true, true);
  const finalWhole = new THREE.Box3().setFromObject(root);
  const finalWholeH = finalWhole.max.y - finalWhole.min.y;
  const hc = new THREE.Vector3();
  let height: number;

  if (headOnly && faceMesh) {
    const fb = new THREE.Box3().setFromObject(faceMesh);
    fb.getCenter(hc);
    height = fb.max.y - fb.min.y;
  } else if (headBone) {
    // Most reliable for skinned avatars: the head bone marks the head.
    headBone.getWorldPosition(hc);
    hc.y += finalWholeH * 0.045; // bone pivot is low in the head; raise to eyes
    height = finalWholeH * 0.13; // a human head is ~13% of standing height
  } else {
    hc.set(
      (finalWhole.min.x + finalWhole.max.x) / 2,
      finalWhole.min.y + finalWholeH * 0.9,
      (finalWhole.min.z + finalWhole.max.z) / 2,
    );
    height = finalWholeH * 0.13;
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
