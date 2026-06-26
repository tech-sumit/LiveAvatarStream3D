import * as THREE from 'three';
import type { Composition, Pose, Subject } from '@las/performer-core';
import type { AvatarController } from '../avatar/avatarController.js';
import { frameSubject, makePose } from '../scene/coreAdapter.js';
import { motionCueTurn } from './motionCues.js';
import type { TrackKind } from './types.js';

// The "component library" of timeline blocks. Each entry is what the Add menus
// list; camera entries resolve to a framing, motion entries to an avatar action.
export interface CueDef {
  track: TrackKind;
  label: string;
  color: string;
  defaultDuration: number;
  icon: string; // emoji shown on the Add dialog card
  desc: string; // one-line description shown on the Add dialog card
}

export const CATALOG: Record<string, CueDef> = {
  // ── Camera moves (the target framing; eased over the cue's duration) ─────────
  'cam.enterLeft': { track: 'camera', label: 'Enter from left', color: '#5b8cff', defaultDuration: 2.5, icon: '🎬', desc: 'Slide in from the left' },
  'cam.wide': { track: 'camera', label: 'Wide (studio)', color: '#5b8cff', defaultDuration: 2.0, icon: '🔭', desc: 'Full studio wide shot' },
  'cam.anchor': { track: 'camera', label: 'Anchor (medium)', color: '#5b8cff', defaultDuration: 1.5, icon: '👤', desc: 'Standard news medium (head→torso)' },
  'cam.close': { track: 'camera', label: 'Close-up', color: '#5b8cff', defaultDuration: 1.5, icon: '🔍', desc: 'Tight head & shoulders' },
  'cam.screen': { track: 'camera', label: 'Two-shot + screen', color: '#5b8cff', defaultDuration: 1.8, icon: '🖥', desc: 'Two-shot with the video wall' },
  'cam.orbit': { track: 'camera', label: 'Slow orbit', color: '#5b8cff', defaultDuration: 4.0, icon: '🔄', desc: 'Slow arc around the anchor' },
  // Authored framings: a captured static view, or a recorded free move.
  'cam.custom': { track: 'camera', label: 'Custom view', color: '#7c5bff', defaultDuration: 1.5, icon: '🎯', desc: 'Your captured viewport framing' },
  'cam.path': { track: 'camera', label: 'Recorded move', color: '#ff8c42', defaultDuration: 3.0, icon: '⏺', desc: 'Replay a recorded camera move' },
  // Vision-mixer cut: while active, the recorded output IS the wall/cast video.
  'cam.screenSource': { track: 'camera', label: 'Cut to screen', color: '#e0457b', defaultDuration: 3.0, icon: '✂', desc: 'Cut output to the wall/cast video' },

  // ── Avatar motion (fires once at the cue start) ─────────────────────────────
  'motion.turnScreen': { track: 'motion', label: 'Turn to screen', color: '#3ad29f', defaultDuration: 1.0, icon: '↪', desc: 'Turn to address the wall' },
  'motion.faceFront': { track: 'motion', label: 'Face front', color: '#3ad29f', defaultDuration: 1.0, icon: '⬆', desc: 'Face the camera' },
  'motion.point': { track: 'motion', label: 'Point at screen', color: '#3ad29f', defaultDuration: 1.5, icon: '👉', desc: 'Point at the screen' },
  'motion.wave': { track: 'motion', label: 'Wave', color: '#3ad29f', defaultDuration: 1.5, icon: '👋', desc: 'Wave' },
  'motion.nod': { track: 'motion', label: 'Nod', color: '#3ad29f', defaultDuration: 1.2, icon: '🙂', desc: 'Nod' },
  'motion.explain': { track: 'motion', label: 'Explain (talk)', color: '#3ad29f', defaultDuration: 2.0, icon: '💬', desc: 'Explaining gesture while talking' },
};

export interface CameraPose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

import type { PoseTuple } from './types.js';
export function poseToTuple(p: { pos: THREE.Vector3; target: THREE.Vector3; fov: number }): PoseTuple {
  return [p.pos.x, p.pos.y, p.pos.z, p.target.x, p.target.y, p.target.z, p.fov];
}
export function tupleToPose(t: PoseTuple): CameraPose {
  return { pos: new THREE.Vector3(t[0], t[1], t[2]), target: new THREE.Vector3(t[3], t[4], t[5]), fov: t[6] };
}

// ── Cue → performer-core framing (composeShot) ───────────────────────────────
//
// Camera-preset cues resolve to a single-subject `composeShot` framing around the
// anchor head (hc) sized by the head height (hh). The size presets reproduce the
// former catalog.poseFor numbers EXACTLY (pinned by the performer-core Phase-2
// regression fixtures CAMERA_CLOSE/WIDE/ANCHOR): cu → cam.close, wide → cam.wide,
// medium → cam.anchor (the absolute "anchor-left / screen-right" news set).
//
// The three ANGLED start framings (cam.screen / cam.enterLeft / cam.orbit) are not a
// plain size preset — they carry a horizontal camera + look-at offset that the size
// model doesn't express — so they keep their exact prior offsets (via `anglePose`).
// They remain identical to the pre-refactor build; the spatial Score model folds them
// in later. cam.screenSource is a vision-mixer cut, not a camera pose — it has no
// framing here (handled by the Performance screen channel, not composeShot).

/** The composeShot Composition for a size-preset cue (cu/wide/medium). */
function compositionFor(type: string): Composition {
  switch (type) {
    case 'cam.close':
      return { size: 'cu' };
    case 'cam.wide':
      return { size: 'wide' };
    case 'cam.anchor':
    default:
      // medium reproduces cam.anchor's absolute offsets (avatar-size independent).
      return { size: 'medium' };
  }
}

/** The framed subject(s) for a cue — the anchor head, sized by its head height. */
export function subjectsForCue(_type: string, hc: THREE.Vector3, hh: number): Subject[] {
  return [{ pos: [hc.x, hc.y, hc.z], size: hh }];
}

// Angled start framings (cam.screen / cam.enterLeft / cam.orbit). Verbatim from the
// former poseFor branches — kept exact so the rendered output does not change. Writes
// into the caller-supplied `out` (allocation-free, rule C).
function anglePose(type: string, hc: THREE.Vector3, hh: number, out: CameraPose): CameraPose {
  const eye = hc.y;
  switch (type) {
    case 'cam.screen':
      // angled two-shot showing the anchor (right, head→torso) and the video wall (left/back)
      out.pos.set(hc.x + hh * 2.2, eye, hc.z + hh * 7);
      out.target.set(hc.x - hh * 1.5, eye - hh * 0.35, hc.z - 1.4);
      out.fov = 42;
      break;
    case 'cam.enterLeft':
      out.pos.set(hc.x - hh * 12, eye, hc.z + hh * 5.5);
      out.target.set(hc.x, eye - hh * 0.6, hc.z);
      out.fov = 36;
      break;
    case 'cam.orbit':
    default:
      out.pos.set(hc.x - hh * 4.5, eye, hc.z + hh * 5.5);
      out.target.set(hc.x, eye - hh * 0.6, hc.z);
      out.fov = 36;
      break;
  }
  return out;
}

// Reusable performer-core Pose scratch for the size-preset composeShot solve (rule C):
// poseFor reads it out into a CameraPose immediately, so a single module-scope buffer is
// safe even across the from/to pair (each call is fully consumed before the next).
const _presetPose: Pose = makePose();

// Resolve a camera preset to a concrete pose around the anchor head (hc) sized by the
// head height (hh). The studio video wall sits behind the anchor (~z −2.55). Every
// size-preset framing keeps the camera at the model's face height and looks at the
// face (composeShot's single-subject math), so all presets stay consistently aligned
// regardless of how tall the loaded avatar is. Pass `out` to reuse a CameraPose buffer on
// the per-frame path (allocation-free); omit it to allocate a fresh pose.
export function poseFor(type: string, hc: THREE.Vector3, hh: number, out?: CameraPose): CameraPose {
  const dst = out ?? { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 0 };
  if (type === 'cam.screen' || type === 'cam.enterLeft' || type === 'cam.orbit') {
    return anglePose(type, hc, hh, dst);
  }
  // Size-preset cues (cu/wide/medium) go through composeShot via the core adapter.
  const pose = frameSubject(hc, hh, compositionFor(type), _presetPose);
  dst.pos.set(pose.pos[0], pose.pos[1], pose.pos[2]);
  dst.target.set(pose.target[0], pose.target[1], pose.target[2]);
  dst.fov = pose.fov;
  return dst;
}

// Fire a motion cue. Returns a talk clip name to play (or null). The turn yaw comes from
// the shared `motionCueTurn` vocabulary (motionCues.ts), the SAME source the unified
// score.drive `turns` channel uses — so preview and take/export can't drift on the turn.
export function applyMotion(type: string, avatar: AvatarController): string | null {
  const yaw = motionCueTurn(type);
  if (yaw !== undefined) avatar.setTurn(yaw);
  switch (type) {
    case 'motion.turnScreen':
    case 'motion.faceFront':
      return null;
    case 'motion.point':
      return 'talk3'; // pointing-ish gesture
    case 'motion.wave':
      return 'talk5';
    case 'motion.nod':
      return 'idle_calm';
    case 'motion.explain':
    default:
      return 'talk1';
  }
}
