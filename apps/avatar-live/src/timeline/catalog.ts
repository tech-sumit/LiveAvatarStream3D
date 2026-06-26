import * as THREE from 'three';
import type { Composition, Pose, Subject } from '@las/performer-core';
import type { AvatarController } from '../avatar/avatarController.js';
import { frameSubject, makePose } from '../scene/coreAdapter.js';
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
// former poseFor branches — kept exact so the rendered output does not change.
function anglePose(type: string, hc: THREE.Vector3, hh: number): CameraPose {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const eye = hc.y;
  switch (type) {
    case 'cam.screen':
      // angled two-shot showing the anchor (right, head→torso) and the video wall (left/back)
      return { pos: v(hc.x + hh * 2.2, eye, hc.z + hh * 7), target: v(hc.x - hh * 1.5, eye - hh * 0.35, hc.z - 1.4), fov: 42 };
    case 'cam.enterLeft':
      return { pos: v(hc.x - hh * 12, eye, hc.z + hh * 5.5), target: v(hc.x, eye - hh * 0.6, hc.z), fov: 36 };
    case 'cam.orbit':
    default:
      return { pos: v(hc.x - hh * 4.5, eye, hc.z + hh * 5.5), target: v(hc.x, eye - hh * 0.6, hc.z), fov: 36 };
  }
}

// Resolve a camera preset to a concrete pose around the anchor head (hc) sized by the
// head height (hh). The studio video wall sits behind the anchor (~z −2.55). Every
// size-preset framing keeps the camera at the model's face height and looks at the
// face (composeShot's single-subject math), so all presets stay consistently aligned
// regardless of how tall the loaded avatar is.
export function poseFor(type: string, hc: THREE.Vector3, hh: number): CameraPose {
  if (type === 'cam.screen' || type === 'cam.enterLeft' || type === 'cam.orbit') {
    return anglePose(type, hc, hh);
  }
  // Size-preset cues (cu/wide/medium) go through composeShot via the core adapter.
  const pose = frameSubject(hc, hh, compositionFor(type), makePose());
  return poseToCamera(pose);
}

/** A plain-tuple performer-core Pose → a THREE.Vector3-based CameraPose. */
function poseToCamera(p: Pose): CameraPose {
  return {
    pos: new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]),
    target: new THREE.Vector3(p.target[0], p.target[1], p.target[2]),
    fov: p.fov,
  };
}

// Avatar-relative turn toward the studio screen (it's behind, so a partial turn
// reads as "addressing the wall"). +radians = turn the avatar's right shoulder back.
const SCREEN_TURN = 0.6;

// Fire a motion cue. Returns a talk clip name to play (or null).
export function applyMotion(type: string, avatar: AvatarController): string | null {
  switch (type) {
    case 'motion.turnScreen':
      avatar.setTurn(SCREEN_TURN);
      return null;
    case 'motion.faceFront':
      avatar.setTurn(0);
      return null;
    case 'motion.point':
      avatar.setTurn(SCREEN_TURN * 0.7);
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
