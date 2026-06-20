import * as THREE from 'three';
import type { FaceChannels, FaceRig } from './face.js';

// Maps abstract face channels onto glTF morph targets. Avatars from different
// pipelines name their blendshapes differently (ARKit, Oculus/Ready Player Me,
// custom), so each channel lists candidate morph names and we bind whatever the
// mesh actually has. This is the browser sibling of engine-three's morphApply.ts.
const CHANNEL_CANDIDATES: Record<keyof FaceChannels, string[]> = {
  // jaw / overall openness — ARKit jawOpen, Oculus viseme_aa, generic mouthOpen
  jawOpen: ['jawOpen', 'JawOpen', 'mouthOpen', 'viseme_aa', 'viseme_AA', 'MouthOpen'],
  // wide / spread — smiles + close front vowels
  mouthWide: [
    'mouthSmileLeft',
    'mouthSmileRight',
    'mouthSmile',
    'viseme_E',
    'viseme_I',
    'mouthStretchLeft',
    'mouthStretchRight',
  ],
  // rounded — funnel / pucker + back vowels
  mouthRound: ['mouthFunnel', 'mouthPucker', 'viseme_O', 'viseme_U', 'MouthPucker'],
  // bilabial closure
  mouthClose: ['mouthClose', 'viseme_PP', 'mouthPressLeft', 'mouthPressRight', 'viseme_sil'],
  // emotion
  smile: ['mouthSmileLeft', 'mouthSmileRight', 'mouthSmile', 'cheekSquintLeft', 'cheekSquintRight'],
  frown: ['mouthFrownLeft', 'mouthFrownRight', 'mouthFrown'],
  browRaise: ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'BrowsU_C'],
  blink: ['eyeBlinkLeft', 'eyeBlinkRight', 'eyesClosed', 'blink', 'EyeBlink_L', 'EyeBlink_R'],
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

  /** Number of distinct morph targets we managed to bind — 0 means unusable. */
  readonly boundCount: number;
  readonly boundNames: string[];

  constructor(root: THREE.Object3D) {
    const found = new Set<string>();
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) meshes.push(m);
    });

    for (const channel of Object.keys(CHANNEL_CANDIDATES) as (keyof FaceChannels)[]) {
      for (const name of CHANNEL_CANDIDATES[channel]) {
        for (const mesh of meshes) {
          const dict = mesh.morphTargetDictionary!;
          const idx = dict[name];
          if (idx !== undefined && mesh.morphTargetInfluences) {
            this.bindings[channel].push({ influences: mesh.morphTargetInfluences, index: idx });
            found.add(name);
          }
        }
      }
    }
    this.boundNames = [...found];
    // Mouth motion is what makes lipsync read; count those channels specifically.
    this.boundCount =
      this.bindings.jawOpen.length + this.bindings.mouthWide.length + this.bindings.mouthRound.length;
  }

  apply(c: FaceChannels): void {
    this.write('jawOpen', c.jawOpen);
    this.write('mouthWide', Math.max(c.mouthWide, c.smile * 0.6));
    this.write('mouthRound', c.mouthRound);
    this.write('mouthClose', c.mouthClose);
    this.write('frown', c.frown);
    this.write('browRaise', c.browRaise);
    this.write('blink', c.blink);
  }

  private write(channel: keyof FaceChannels, value: number): void {
    const v = clamp01(value);
    for (const b of this.bindings[channel]) b.influences[b.index] = v;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
