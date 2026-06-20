import * as THREE from 'three';
import type { Stage } from '../scene/stage.js';
import type { AvatarController } from '../avatar/avatarController.js';
import { applyMotion, poseFor, tupleToPose, type CameraPose } from './catalog.js';
import type { Cue, Timeline } from './types.js';

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
    this.updateScreenSource(t);
  }

  // "Cut to screen" cues toggle the recorded output to the wall/cast video.
  private updateScreenSource(t: number): void {
    const cues = this.timeline.cues.filter((c) => c.type === 'cam.screenSource');
    if (!cues.length) return; // leave the manual toggle alone if none authored
    const active = cues.some((c) => c.start <= t && t < c.start + c.duration);
    this.stage.setOutputSource(active ? 'screen' : 'scene');
  }

  private updateCamera(t: number): void {
    const cam = this.timeline.cues
      .filter((c) => c.track === 'camera' && c.type !== 'cam.screenSource')
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

    // Recorded free move: replay the captured path exactly (no from-easing).
    if (active.path && active.path.length) {
      const pose = samplePath(active.path, t - active.start);
      this.stage.setCameraPose(pose.pos, pose.target, pose.fov);
      return;
    }

    const to = this.resolvePose(active, hc, hh);
    const from = idx > 0 ? this.resolvePose(cam[idx - 1], hc, hh) : to;
    const e = easeInOut(active.duration > 0 ? clamp01((t - active.start) / active.duration) : 1);
    const pose = lerpPose(from, to, e);
    this.stage.setCameraPose(pose.pos, pose.target, pose.fov);
  }

  // A cue's end framing: recorded path's last key, a captured pose, or a preset.
  private resolvePose(cue: Cue, hc: THREE.Vector3, hh: number): CameraPose {
    if (cue.path && cue.path.length) return tupleToPose(cue.path[cue.path.length - 1].p);
    if (cue.pose) return tupleToPose(cue.pose);
    return poseFor(cue.type, hc, hh);
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
// Interpolate a recorded camera path at local time t (seconds).
function samplePath(path: { t: number; p: number[] }[], t: number): CameraPose {
  if (t <= path[0].t) return tupleToPose(path[0].p as never);
  const last = path[path.length - 1];
  if (t >= last.t) return tupleToPose(last.p as never);
  let i = 0;
  while (i < path.length - 1 && path[i + 1].t <= t) i++;
  const a = path[i];
  const b = path[Math.min(i + 1, path.length - 1)];
  const span = b.t - a.t;
  const f = span > 1e-5 ? (t - a.t) / span : 0;
  const p: number[] = [];
  for (let k = 0; k < 7; k++) p[k] = a.p[k] + (b.p[k] - a.p[k]) * f;
  return tupleToPose(p as never);
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
