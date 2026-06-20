import * as THREE from 'three';
import type { FaceChannels, FaceRig } from './face.js';

// Fallback for rigged avatars that have NO facial blendshapes but DO have a jaw
// bone in the skeleton (some game/DAZ/Character-Creator rigs). It can only open
// and close the mouth — no visemes, no expression — but that's enough to read as
// talking. Models with neither blendshapes nor a jaw bone (most Mixamo rigs and
// all static/photogrammetry meshes) have a frozen face and cannot lip-sync at all.
export class JawBoneRig implements FaceRig {
  readonly jawBone: THREE.Object3D | null;
  readonly headBone: THREE.Object3D | null;
  private restX = 0;
  private openAxisSign = 1;

  get found(): boolean {
    return this.jawBone !== null;
  }

  constructor(root: THREE.Object3D) {
    const bones: THREE.Object3D[] = [];
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone || /bone|joint/i.test(o.type)) bones.push(o);
    });
    this.jawBone = pick(bones, [/jaw/i, /\bchin\b/i]);
    this.headBone = pick(bones, [/^.*head$/i, /head/i]);
    if (this.jawBone) {
      this.restX = this.jawBone.rotation.x;
      // Heuristic: a jaw usually sits below the head's pivot; opening rotates it
      // forward/down. We can't know the rig's convention, so default to +X and
      // let users flip via a model that defines blendshapes instead.
      this.openAxisSign = 1;
    }
  }

  apply(c: FaceChannels): void {
    if (!this.jawBone) return;
    // Up to ~22° of jaw rotation at full open.
    this.jawBone.rotation.x = this.restX + this.openAxisSign * c.jawOpen * 0.38;
  }
}

function pick(bones: THREE.Object3D[], patterns: RegExp[]): THREE.Object3D | null {
  for (const re of patterns) {
    const hit = bones.find((b) => re.test(b.name));
    if (hit) return hit;
  }
  return null;
}
