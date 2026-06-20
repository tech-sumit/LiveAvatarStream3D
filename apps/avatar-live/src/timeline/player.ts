import * as THREE from 'three';
import type { Stage } from '../scene/stage.js';
import type { AvatarController } from '../avatar/avatarController.js';
import { applyMotion, poseFor, type CameraPose } from './catalog.js';
import type { Timeline } from './types.js';

// Plays a Timeline against a clock: eases the camera between camera-cue framings
// and fires motion cues once at their start. Used both for live preview and,
// during export, driven by the render's audio clock so everything stays synced.
export class TimelinePlayer {
  private timeline: Timeline = { duration: 0, cues: [] };
  private firedMotion = new Set<string>();
  private playClip: (name: string) => void = () => {};

  constructor(
    private stage: Stage,
    private avatar: AvatarController,
  ) {}

  setClipPlayer(fn: (name: string) => void): void {
    this.playClip = fn;
  }

  load(timeline: Timeline): void {
    this.timeline = timeline;
  }

  /** Take the camera and reset playback state to t=0. */
  begin(): void {
    this.firedMotion.clear();
    this.stage.setDirector(true);
    this.update(0);
  }

  /** Release the camera back to OrbitControls. */
  end(): void {
    this.stage.setDirector(false);
    this.avatar.setTurn(0);
  }

  get duration(): number {
    return this.timeline.duration;
  }

  hasCameraCues(): boolean {
    return this.timeline.cues.some((c) => c.track === 'camera');
  }

  update(t: number): void {
    this.updateCamera(t);
    this.fireMotion(t);
  }

  private updateCamera(t: number): void {
    const cam = this.timeline.cues
      .filter((c) => c.track === 'camera')
      .sort((a, b) => a.start - b.start);
    if (!cam.length) return;

    const hc = this.avatar.headCenter.clone().add(this.avatar.group.position);
    const hh = this.avatar.headHeight;

    let idx = 0;
    for (let i = 0; i < cam.length; i++) {
      if (cam[i].start <= t) idx = i;
      else break;
    }
    const active = cam[idx];
    const to = poseFor(active.type, hc, hh);
    const from = idx > 0 ? poseFor(cam[idx - 1].type, hc, hh) : to;
    const p = active.duration > 0 ? clamp01((t - active.start) / active.duration) : 1;
    const e = easeInOut(p);

    const pose = lerpPose(from, to, e);
    this.stage.setCameraPose(pose.pos, pose.target, pose.fov);
  }

  private fireMotion(t: number): void {
    for (const c of this.timeline.cues) {
      if (c.track !== 'motion') continue;
      if (c.start <= t && !this.firedMotion.has(c.id)) {
        this.firedMotion.add(c.id);
        const clip = applyMotion(c.type, this.avatar);
        if (clip) this.playClip(clip);
      }
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}
function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  return {
    pos: new THREE.Vector3().lerpVectors(a.pos, b.pos, t),
    target: new THREE.Vector3().lerpVectors(a.target, b.target, t),
    fov: a.fov + (b.fov - a.fov) * t,
  };
}
