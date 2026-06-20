import * as THREE from 'three';
import type { AvatarController } from '../avatar/avatarController.js';
import type { TrackKind } from './types.js';

// The "component library" of timeline blocks. Each entry is what the Add menus
// list; camera entries resolve to a framing, motion entries to an avatar action.
export interface CueDef {
  track: TrackKind;
  label: string;
  color: string;
  defaultDuration: number;
}

export const CATALOG: Record<string, CueDef> = {
  // ── Camera moves (the target framing; eased over the cue's duration) ─────────
  'cam.enterLeft': { track: 'camera', label: 'Enter from left', color: '#5b8cff', defaultDuration: 2.5 },
  'cam.wide': { track: 'camera', label: 'Wide (studio)', color: '#5b8cff', defaultDuration: 2.0 },
  'cam.anchor': { track: 'camera', label: 'Anchor (medium)', color: '#5b8cff', defaultDuration: 1.5 },
  'cam.close': { track: 'camera', label: 'Close-up', color: '#5b8cff', defaultDuration: 1.5 },
  'cam.screen': { track: 'camera', label: 'Two-shot + screen', color: '#5b8cff', defaultDuration: 1.8 },
  'cam.orbit': { track: 'camera', label: 'Slow orbit', color: '#5b8cff', defaultDuration: 4.0 },
  // Authored framings: a captured static view, or a recorded free move.
  'cam.custom': { track: 'camera', label: 'Custom view', color: '#7c5bff', defaultDuration: 1.5 },
  'cam.path': { track: 'camera', label: 'Recorded move', color: '#ff8c42', defaultDuration: 3.0 },
  // Vision-mixer cut: while active, the recorded output IS the wall/cast video.
  'cam.screenSource': { track: 'camera', label: 'Cut to screen', color: '#e0457b', defaultDuration: 3.0 },

  // ── Avatar motion (fires once at the cue start) ─────────────────────────────
  'motion.turnScreen': { track: 'motion', label: 'Turn to screen', color: '#3ad29f', defaultDuration: 1.0 },
  'motion.faceFront': { track: 'motion', label: 'Face front', color: '#3ad29f', defaultDuration: 1.0 },
  'motion.point': { track: 'motion', label: 'Point at screen', color: '#3ad29f', defaultDuration: 1.5 },
  'motion.wave': { track: 'motion', label: 'Wave', color: '#3ad29f', defaultDuration: 1.5 },
  'motion.nod': { track: 'motion', label: 'Nod', color: '#3ad29f', defaultDuration: 1.2 },
  'motion.explain': { track: 'motion', label: 'Explain (talk)', color: '#3ad29f', defaultDuration: 2.0 },
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

// Resolve a camera preset to a concrete pose around the anchor head (hc) sized by
// the head height (hh). The studio video wall sits behind the anchor (~z −2.55).
//
// Every framing keeps the camera at the model's face height (eye = hc.y) and
// looks at the face, so all presets are consistently aligned regardless of how
// tall the loaded avatar is. Wider shots only pull back / drop the *target*
// slightly to reveal the body — the camera itself stays level with the face.
export function poseFor(type: string, hc: THREE.Vector3, hh: number): CameraPose {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const eye = hc.y;
  switch (type) {
    case 'cam.close':
      return { pos: v(hc.x, eye, hc.z + hh * 2.2), target: v(hc.x, eye, hc.z), fov: 30 };
    case 'cam.wide':
      return { pos: v(hc.x, eye, hc.z + hh * 8.5), target: v(hc.x, eye - hh * 0.7, hc.z), fov: 40 };
    case 'cam.screen':
      // angled two-shot showing the anchor (right) and the video wall (left/back)
      return { pos: v(hc.x + hh * 2.2, eye, hc.z + hh * 7), target: v(hc.x - hh * 1.5, eye + hh * 0.2, hc.z - 1.4), fov: 42 };
    case 'cam.enterLeft':
      return { pos: v(hc.x - hh * 10, eye, hc.z + hh * 4.5), target: v(hc.x, eye, hc.z), fov: 36 };
    case 'cam.orbit':
      return { pos: v(hc.x - hh * 3.5, eye, hc.z + hh * 4.5), target: v(hc.x, eye, hc.z), fov: 36 };
    case 'cam.anchor':
    default:
      return { pos: v(hc.x, eye, hc.z + hh * 3.6), target: v(hc.x, eye, hc.z), fov: 35 };
  }
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
