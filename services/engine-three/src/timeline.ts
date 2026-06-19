import type { CameraShotKeyframe, ManifestBeat, MontageId, PerformanceManifest } from '@las/protocol';
import { MathUtils, PerspectiveCamera } from 'three';
import type { FaceFrame } from './face/a2f.js';
import {
  easeT,
  moveDelta,
  SHOT_PARAMS,
  shotBasePosition,
} from './camera.js';
import type { AvatarRig } from './avatar/loadAvatar.js';
import { applyFaceToAvatar } from './avatar/loadAvatar.js';

function activeCameraCue(cues: CameraShotKeyframe[], t: number): CameraShotKeyframe {
  for (let i = cues.length - 1; i >= 0; i--) {
    const c = cues[i];
    if (t >= c.startS && t < c.startS + c.durationS) return c;
  }
  return cues[0];
}

function activeBeat(beats: ManifestBeat[], t: number): ManifestBeat {
  for (let i = beats.length - 1; i >= 0; i--) {
    if (t >= beats[i].startS) return beats[i];
  }
  return beats[0];
}

function applyProceduralMontage(
  avatar: AvatarRig,
  montageId: MontageId | null,
  t: number,
  beatStart: number,
): void {
  if (!avatar.head || !avatar.leftArm || !avatar.rightArm) return;
  const phase = t - beatStart;
  avatar.leftArm.rotation.x = 0.35;
  avatar.rightArm.rotation.x = -0.35;

  switch (montageId) {
    case 'M_Explain':
      avatar.leftArm.rotation.z = 0.35 + Math.sin(phase * 4) * 0.15;
      avatar.rightArm.rotation.z = -0.35 - Math.sin(phase * 4) * 0.15;
      break;
    case 'M_LeanIn':
      avatar.root.rotation.x = MathUtils.lerp(avatar.root.rotation.x, 0.12, 0.08);
      avatar.root.position.z = MathUtils.lerp(avatar.root.position.z, 0.08, 0.08);
      break;
    case 'M_Nod':
      avatar.head.rotation.x = Math.sin(phase * 6) * 0.12;
      break;
    case null:
      avatar.root.rotation.x = MathUtils.lerp(avatar.root.rotation.x, 0, 0.05);
      avatar.root.position.z = MathUtils.lerp(avatar.root.position.z, 0, 0.05);
      avatar.head.rotation.x = MathUtils.lerp(avatar.head.rotation.x, 0, 0.1);
      break;
    default: {
      const _exhaustive: never = montageId;
      return _exhaustive;
    }
  }
}

function applyBodyPosture(avatar: AvatarRig, beat: ManifestBeat): void {
  avatar.root.rotation.y = MathUtils.degToRad(beat.body.yawDeg);
  if (avatar.torso) avatar.torso.rotation.x = beat.body.lean * 0.18;
}

/** Update avatar animation for time `t` (seconds). Camera unchanged — editor WYSIWYG mode. */
export function applyTimelineBody(
  manifest: PerformanceManifest,
  avatar: AvatarRig,
  faceFrames: FaceFrame[],
  frameIndex: number,
  deltaS: number,
): void {
  const t = frameIndex / manifest.fps;
  const beat = activeBeat(manifest.beats, t);

  applyBodyPosture(avatar, beat);
  avatar.montage.applyMontage(beat.body.montageId);
  if (avatar.proceduralMontages) {
    applyProceduralMontage(avatar, beat.body.montageId, t, beat.startS);
  }
  avatar.montage.update(deltaS);

  const face = faceFrames[frameIndex] ?? faceFrames[faceFrames.length - 1];
  applyFaceToAvatar(avatar, face);
}

/** Lip-sync + montage only — preserves editor-authored avatar transform. */
export function applyTimelineFaceOnly(
  manifest: PerformanceManifest,
  avatar: AvatarRig,
  faceFrames: FaceFrame[],
  frameIndex: number,
  deltaS: number,
): void {
  const beat = activeBeat(manifest.beats, frameIndex / manifest.fps);
  avatar.montage.applyMontage(beat.body.montageId);
  avatar.montage.update(deltaS);
  const face = faceFrames[frameIndex] ?? faceFrames[faceFrames.length - 1];
  applyFaceToAvatar(avatar, face);
}

/** Update camera + avatar for time `t` (seconds). */
export function applyTimeline(
  manifest: PerformanceManifest,
  camera: PerspectiveCamera,
  avatar: AvatarRig,
  faceFrames: FaceFrame[],
  frameIndex: number,
  deltaS: number,
): void {
  applyTimelineBody(manifest, avatar, faceFrames, frameIndex, deltaS);

  const t = frameIndex / manifest.fps;
  const cue = activeCameraCue(manifest.camera, t);

  const { distance } = SHOT_PARAMS[cue.shot];
  const { position, lookAt, fov } = shotBasePosition(cue.shot, cue.target, cue.intensity);
  const { dPos } = moveDelta(cue.move, distance, cue.intensity);

  const localT = cue.durationS > 0 ? (t - cue.startS) / cue.durationS : 0;
  const e = easeT(Math.max(0, Math.min(1, localT)), cue.easing);

  const pos = position.clone().lerp(position.clone().add(dPos), e);
  camera.position.copy(pos);
  camera.fov = fov;
  camera.lookAt(lookAt);
  camera.updateProjectionMatrix();
}
