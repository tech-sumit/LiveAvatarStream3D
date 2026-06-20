import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { zeroChannels, type FaceChannels, type FaceRig } from './face.js';
import { MorphFaceRig } from './morphRig.js';
import { createProceduralHead } from './proceduralHead.js';
import { emotionBias, type EmotionName } from './emotion.js';

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
  description = 'procedural head';

  private rig: FaceRig;
  private current: FaceChannels = zeroChannels();
  private mouthTarget: MouthCue = { ...SILENT };
  private emotion: EmotionName = 'neutral';
  private emotionIntensity = 1;
  private speaking = false;

  // blink state
  private nextBlinkAt = 1.5;
  private blinkClock = 0;
  private blinkPhase = -1; // -1 idle, else 0..1 progress

  // idle motion
  private idleClock = 0;

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

  /** Replace the procedural head with a glTF avatar if it exposes usable morphs. */
  async loadGltf(url: string): Promise<boolean> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;
    const rig = new MorphFaceRig(root);
    if (rig.boundCount === 0) {
      // No mouth morphs — keep the procedural head, but tell the caller.
      return false;
    }
    this.group.clear();
    normalizeAvatar(root);
    this.group.add(root);
    this.rig = rig;
    this.current = zeroChannels();
    this.headCenter = computeHeadCenter(root);
    this.description = `glTF (${rig.boundNames.length} morphs: ${rig.boundNames.slice(0, 4).join(', ')}…)`;
    return true;
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

  update(dt: number): void {
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

function normalizeAvatar(root: THREE.Object3D): void {
  // Center on origin and scale so the head sits near y=1.6 (standing).
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const targetHeight = 1.7;
  const scale = size.y > 0 ? targetHeight / size.y : 1;
  root.scale.setScalar(scale);
  root.position.x -= center.x * scale;
  root.position.z -= center.z * scale;
  root.position.y -= box.min.y * scale; // feet at 0
  root.traverse((o) => {
    o.castShadow = true;
    o.frustumCulled = false;
  });
}

function computeHeadCenter(root: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(root);
  // Eyes sit roughly 92% up a human figure.
  return new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y + (box.max.y - box.min.y) * 0.92, box.max.z);
}
