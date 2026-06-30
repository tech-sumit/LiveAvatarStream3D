import * as THREE from 'three';
import { CAMERA_SHOTS, CAMERA_SHOT_IDS, type CameraShotId } from '@las/performer-core';
import { poseForShotId, type CameraPose } from '../timeline/catalog.js';
import type { StudioContext } from './context.js';

// Live #shot dropdown ↔ the shared @las/performer-core shot-preset catalog. A static preset
// places the camera once; the `push-in` preset self-animates over its duration via rAF (the
// newscast/timeline gets the dolly for free from cue-to-cue easing). Roll (dutch) is carried
// through to stage.setCameraPose. World head center = local headCenter + the avatar's group
// position, so the framing is correct even after the avatar has been moved with the gizmo.

const _hc = new THREE.Vector3();
const _pose: CameraPose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 0, roll: 0 };

function worldHead(app: StudioContext): THREE.Vector3 {
  return _hc.copy(app.avatar.headCenter).add(app.avatar.group.position);
}

// Monotonic token: bumping it cancels any in-flight push-in rAF (so switching shots mid-dolly
// doesn't leave two animations fighting over the camera).
let _animToken = 0;

/** True for a catalog id (so callers can fall back for legacy/unknown values). */
export function isShotId(id: string): id is CameraShotId {
  return id in CAMERA_SHOTS;
}

/** Apply a catalog shot preset to the live camera by id. Unknown ids are ignored. */
export function applyShot(app: StudioContext, id: string): void {
  _animToken++;
  if (!isShotId(id)) return;
  const preset = CAMERA_SHOTS[id];
  const hh = app.avatar.headHeight;

  const move = preset.move;
  if (move && move.kind === 'push-in') {
    const token = _animToken;
    const startMs = performance.now();
    const step = (now: number): void => {
      if (token !== _animToken) return; // superseded by a newer shot selection
      const tSec = Math.min((now - startMs) / 1000, move.durationSec);
      const p = poseForShotId(id, worldHead(app), hh, tSec, _pose);
      app.stage.setCameraPose(p.pos, p.target, p.fov, p.roll ?? 0);
      if (tSec < move.durationSec) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return;
  }

  const p = poseForShotId(id, worldHead(app), hh, 0, _pose);
  app.stage.setCameraPose(p.pos, p.target, p.fov, p.roll ?? 0);
}

/** Fill the #shot <select> with the full catalog (labels from the presets). Idempotent. */
export function populateShotDropdown(sel: HTMLSelectElement): void {
  const prev = sel.value;
  sel.innerHTML = '';
  for (const id of CAMERA_SHOT_IDS) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = CAMERA_SHOTS[id].label;
    sel.appendChild(opt);
  }
  sel.value = isShotId(prev) ? prev : 'medium';
}
