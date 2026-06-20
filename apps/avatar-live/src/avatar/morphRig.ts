import * as THREE from 'three';
import type { FaceChannels, FaceRig } from './face.js';

// Maps abstract face channels onto glTF morph targets. Each channel lists ordered
// candidate GROUPS; we bind the first group the mesh actually has and drive only
// that one — so we never stack smile + stretch + viseme on the same channel
// (which grimaces a realistic face). Speech channels use speech shapes; smile is
// reserved for emotion. Spans ARKit camelCase (RPM/Avaturn), ARKit underscore
// (facecap), and Oculus visemes. Sibling of engine-three's morphApply.ts.
const CHANNEL_GROUPS: Record<keyof FaceChannels, string[][]> = {
  jawOpen: [['jawOpen'], ['JawOpen'], ['mouthOpen'], ['viseme_aa'], ['viseme_AA']],
  // "ee/ih" spread — prefer stretch, then visemes; smile is NOT used for speech.
  mouthWide: [
    ['mouthStretchLeft', 'mouthStretchRight'],
    ['mouthStretch_L', 'mouthStretch_R'],
    ['viseme_E', 'viseme_I'],
  ],
  // "oo/oh" round — funnel/pucker or back visemes.
  mouthRound: [['mouthFunnel'], ['mouthPucker'], ['viseme_O', 'viseme_U'], ['MouthPucker']],
  // bilabial closure.
  mouthClose: [
    ['mouthClose'],
    ['viseme_PP'],
    ['mouthPressLeft', 'mouthPressRight'],
    ['mouthPress_L', 'mouthPress_R'],
  ],
  // emotion only.
  smile: [['mouthSmileLeft', 'mouthSmileRight'], ['mouthSmile_L', 'mouthSmile_R'], ['mouthSmile']],
  frown: [['mouthFrownLeft', 'mouthFrownRight'], ['mouthFrown_L', 'mouthFrown_R'], ['mouthFrown']],
  browRaise: [['browInnerUp'], ['browOuterUpLeft', 'browOuterUpRight'], ['browOuterUp_L', 'browOuterUp_R']],
  blink: [['eyeBlinkLeft', 'eyeBlinkRight'], ['eyeBlink_L', 'eyeBlink_R'], ['eyesClosed'], ['blink']],
};

interface Binding {
  influences: number[];
  index: number;
}

export class MorphFaceRig implements FaceRig {
  private bindings: Record<keyof FaceChannels, Binding[]> = {
    jawOpen: [],
    mouthWide: [],
    mouthRound: [],
    mouthClose: [],
    smile: [],
    frown: [],
    browRaise: [],
    blink: [],
  };

  readonly boundCount: number;
  readonly boundNames: string[];

  // Every morph keyed by a normalized name, so an external ARKit-named timeline
  // (Audio2Face-3D) can drive the full face regardless of naming convention.
  private named = new Map<string, Binding[]>();

  constructor(root: THREE.Object3D) {
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) meshes.push(m);
    });

    for (const mesh of meshes) {
      for (const [name, idx] of Object.entries(mesh.morphTargetDictionary!)) {
        if (!mesh.morphTargetInfluences) continue;
        const key = normalizeMorphName(name);
        const list = this.named.get(key) ?? [];
        list.push({ influences: mesh.morphTargetInfluences, index: idx });
        this.named.set(key, list);
      }
    }

    const found = new Set<string>();
    for (const channel of Object.keys(CHANNEL_GROUPS) as (keyof FaceChannels)[]) {
      for (const group of CHANNEL_GROUPS[channel]) {
        const bindings = this.bindForGroup(group, found);
        if (bindings.length) {
          this.bindings[channel] = bindings;
          break; // first matching group wins — don't stack overlapping shapes
        }
      }
    }
    this.boundNames = [...found];
    this.boundCount =
      this.bindings.jawOpen.length + this.bindings.mouthWide.length + this.bindings.mouthRound.length;
  }

  private bindForGroup(names: string[], found: Set<string>): Binding[] {
    const out: Binding[] = [];
    for (const name of names) {
      const list = this.named.get(normalizeMorphName(name));
      if (list) {
        out.push(...list);
        found.add(name);
      }
    }
    return out;
  }

  apply(c: FaceChannels): void {
    this.write('jawOpen', c.jawOpen);
    this.write('mouthWide', c.mouthWide);
    this.write('mouthRound', c.mouthRound);
    this.write('mouthClose', c.mouthClose);
    this.write('smile', c.smile);
    this.write('frown', c.frown);
    this.write('browRaise', c.browRaise);
    this.write('blink', c.blink);
  }

  private write(channel: keyof FaceChannels, value: number): void {
    const v = clamp01(value);
    for (const b of this.bindings[channel]) b.influences[b.index] = v;
  }

  /** Set specific named morphs without zeroing others (e.g. eye-gaze on top of lip-sync). */
  applyExtra(weights: Record<string, number>): void {
    for (const [name, w] of Object.entries(weights)) {
      const list = this.named.get(normalizeMorphName(name));
      if (!list) continue;
      const v = clamp01(w);
      for (const b of list) b.influences[b.index] = v;
    }
  }

  /** Drive the full face from a name→weight map (an A2F-3D / ARKit frame). */
  applyNamed(weights: Record<string, number>): void {
    for (const list of this.named.values()) {
      for (const b of list) b.influences[b.index] = 0;
    }
    for (const [name, w] of Object.entries(weights)) {
      const list = this.named.get(normalizeMorphName(name));
      if (!list) continue;
      const v = clamp01(w);
      for (const b of list) b.influences[b.index] = v;
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Canonicalize a blendshape name so ARKit conventions match: lowercase, drop
// separators, fold Left/Right ↔ _L/_R. "mouthSmileLeft", "mouthSmile_L" → "mouthsmilel".
function normalizeMorphName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_\s.]+/g, '')
    .replace(/left$/, 'l')
    .replace(/right$/, 'r');
}
