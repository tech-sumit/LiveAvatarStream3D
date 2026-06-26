// ─────────────────────────────────────────────────────────────────────────────
// Regression fixtures — the EXACT avatar-live numbers the Score/Stage cut-over must
// preserve. Single source of truth: every solver test imports from here, and the
// later avatar-live cutover phases (4a/4b/4c) prove parity against these same values.
//
// Each constant is annotated with the precise avatar-live source it pins. Expected
// poses/quats were computed from those formulas (and the quaternion cases verified
// equal to three@0.152.2 to 12 decimal places — see the package commit notes).
//
// NO three.js, NO zod — plain numbers only, so this file is importable by the pure
// performer-core tests.
// ─────────────────────────────────────────────────────────────────────────────
import type { Quat, Vec3 } from '../types.js';

export interface PoseFixture {
  pos: Vec3;
  target: Vec3;
  fov: number;
}

// Procedural-head defaults the studio boots with (avatarController.ts:93,170).
export const AVATAR_DEFAULTS = {
  headCenter: [0, 1.53, 0] as Vec3,
  headHeight: 0.42,
};

// ── composeShot — catalog.poseFor (timeline/catalog.ts:60-86) ────────────────
// Computed for AVATAR_DEFAULTS (eye = headCenter.y = 1.53).
export const CAMERA_CLOSE: { input: { hc: Vec3; hh: number }; expected: PoseFixture } = {
  // cam.close: pos.z = hc.z + hh*4.0, target.y = eye - hh*0.25, fov 30.
  input: { hc: [0, 1.53, 0], hh: 0.42 },
  expected: { pos: [0, 1.53, 1.68], target: [0, 1.425, 0], fov: 30 },
};
export const CAMERA_WIDE: { input: { hc: Vec3; hh: number }; expected: PoseFixture } = {
  // cam.wide: pos.z = hc.z + hh*9.0, target.y = eye - hh*1.1, fov 40.
  input: { hc: [0, 1.53, 0], hh: 0.42 },
  expected: { pos: [0, 1.53, 3.78], target: [0, 1.068, 0], fov: 40 },
};
export const CAMERA_ANCHOR: { input: { hc: Vec3; hh: number }; expected: PoseFixture } = {
  // cam.anchor (default news medium): pos = (hc.x+0.7, eye+0.05, hc.z+5.2),
  // target = (hc.x+0.85, eye-0.18, hc.z), fov 32.
  input: { hc: [0, 1.53, 0], hh: 0.42 },
  expected: { pos: [0.7, 1.58, 5.2], target: [0.85, 1.35, 0], fov: 32 },
};

// ── composeShot — stage.frameAnchorScreen two-shot (scene/stage.ts:176-196), snap ──
// PAD 2.75, fov 40, dist = (spread+PAD)/(2·tan(fov/2)); camera (mx-1.1, 1.75, camZ);
// target (mx+0.1, 1.25, mz+0.9); camZ = max(anchor.z, screen.z) + dist.
export const CAMERA_TWO_SHOT: { input: { anchor: Vec3; screen: Vec3 }; expected: PoseFixture } = {
  input: { anchor: [0, 0, 0], screen: [0, 0, -2.55] },
  // spread = 2.55; dist = (2.55+2.75)/(2·tan(20°)) = 7.28081516155475; camZ = 0 + dist.
  expected: { pos: [-1.1, 1.75, 7.28081516155475], target: [0.1, 1.25, -0.375], fov: 40 },
};

// ── fingerCount — applyCounting (avatarController.ts:75-76, 596-604) ──────────
export const FINGER_CURL: number[] = [-1.0, -1.45, -1.2];
export const COUNT_PHASE = 0.75;
// At a given displayed count, "up" fingers extend (joint 0) and the rest fold to curl[j].
// curls[finger][joint]; fingers = index, middle, ring, pinky (pinky always curled).
function countCurls(shown: number): number[][] {
  const up = [shown >= 1, shown >= 2, shown >= 3, false];
  return up.map((u) => FINGER_CURL.map((c) => (u ? 0 : c)));
}
export const FINGER_COUNT_1 = { input: { n: 3, t: 0.0 }, expected: countCurls(1) }; // t < phase → 1
export const FINGER_COUNT_2 = { input: { n: 3, t: 0.75 }, expected: countCurls(2) }; // phase ≤ t < 2·phase → 2
export const FINGER_COUNT_3 = { input: { n: 3, t: 1.5 }, expected: countCurls(3) }; // t ≥ 2·phase → 3

// ── aimEye — applyGaze clamp/weight (avatarController.ts:688-690) ─────────────
export const GAZE_MAX_ANGLE = 0.5;
export const GAZE_WEIGHT = 0.85;
// Expected normalized morph weights (recoverable from the returned quat as |aim|/maxAngle).
export const EYE_RIGHT = {
  input: { dir: [1, 0, 1] as Vec3 }, // hA = 45° → clamped, hw = 0.85; vw = 0
  expected: { hw: 0.85, vw: 0, quat: [0, 0.2109043231, 0, 0.9775067092] as Quat },
};
export const EYE_UP_RIGHT = {
  input: { dir: [0.6, 0.4, 1] as Vec3 },
  expected: { hw: 0.85, vw: 0.6468608411, quat: [0.1573896004, 0.2081525631, -0.0339579737, 0.964752756] as Quat },
};
export const EYE_FORWARD = {
  input: { dir: [0, 0, 1] as Vec3 },
  expected: { hw: 0, vw: 0, quat: [0, 0, 0, 1] as Quat },
};
export const EYE_BEHIND = {
  input: { dir: [0, 0, -1] as Vec3 }, // f ≤ 0.05 → gated to identity (no aim)
  expected: { quat: [0, 0, 0, 1] as Quat },
};

// ── turnToward — updateStation travel facing (avatarController.ts:495) ────────
// yaw = atan2(to.x - from.x, to.z - from.z).
export const TURN_CASES: { from: Vec3; to: Vec3; expected: number }[] = [
  { from: [0, 0, 0], to: [0, 0, 1], expected: 0 }, // straight ahead (+Z)
  { from: [0, 0, 0], to: [1, 0, 0], expected: Math.PI / 2 }, // camera-right (+X)
  { from: [0, 0, 0], to: [-1, 0, 0], expected: -Math.PI / 2 }, // camera-left (-X)
  { from: [0, 0, 0], to: [0, 0, -1], expected: Math.PI }, // behind (-Z)
  { from: [0, 0, 0], to: [1, 0, 1], expected: Math.PI / 4 }, // diagonal
  // "face the screen from a mark to its left": station (0.75,0,0.25) → screen (-1.2,0,-2.55).
  { from: [0.75, 0, 0.25], to: [-1.2, 0, -2.55], expected: Math.atan2(-1.95, -2.8) },
];

// ── aimLimb — applyPointing parent-space basis (avatarController.ts:550-563) ──
// upperArm quats verified equal to three@0.152.2's makeBasis + setFromRotationMatrix (12 dp).
// foreArm target is identity (the rig slerps toward it to straighten the forearm).
export const POINT_AIM_WEIGHT = 0.85; // POINT_AIM_WEIGHT (avatarController.ts:61)
export const POINT_FOREARM_WEIGHT = 0.8; // POINT_FOREARM_WEIGHT (avatarController.ts:62)
export const AIM_IDENTITY_PARENT = {
  input: { targetDir: [1, -0.2, 0.3] as Vec3, parentWorldQuat: [0, 0, 0, 1] as Quat },
  expected: {
    side: 'left' as const, // target is camera-right (+X) → LEFT arm aims (no chest cross)
    upperArm: [0.090384215425, -0.11025101872, -0.765442865562, 0.627513048496] as Quat,
    foreArm: [0, 0, 0, 1] as Quat,
  },
};
export const AIM_YAWED_PARENT = {
  // parentWorldQuat = yaw 0.6 about Y → (0, sin0.3, 0, cos0.3).
  input: { targetDir: [1, -0.2, 0.3] as Vec3, parentWorldQuat: [0, 0.2955202066613396, 0, 0.955336489125606] as Quat },
  expected: {
    side: 'left' as const,
    upperArm: [0.250694215629, -0.338526221021, -0.728851491793, 0.539748006798] as Quat,
    foreArm: [0, 0, 0, 1] as Quat,
  },
};
export const AIM_DEGENERATE_Z = {
  // dir ~ +Z triggers the up-reference swap (|Y·Z|>0.99 → Z=(1,0,0)).
  input: { targetDir: [0.05, 0, 1] as Vec3, parentWorldQuat: [0, 0, 0, 1] as Quat },
  expected: {
    side: 'left' as const,
    upperArm: [0.512332318165, 0.512332318165, 0.487355717894, 0.487355717894] as Quat,
    foreArm: [0, 0, 0, 1] as Quat,
  },
};
// side:'auto' flips with the target azimuth: camera-left (-X) → RIGHT arm.
export const AIM_AUTO_LEFT_TARGET = {
  input: { targetDir: [-1, 0, 0.5] as Vec3, parentWorldQuat: [0, 0, 0, 1] as Quat },
  expected: { side: 'right' as const },
};

// ── planPath — replaces STATION_SPEED/WALK_SPEED/BACK_SPEED + arrival facing ──
export const STATION_SPEED = 1.2; // avatarController.ts:68 (planPath default speed)
export const WALK_SPEED = 1.15;
export const BACK_SPEED = 0.75;
export const PATH_CASE = {
  // walk to a mark beside the screen AND face the screen (arriveFacing carried, not hardcoded 0).
  input: { from: [0, 0, 0] as Vec3, to: [0.75, 0, 0.25] as Vec3, arriveFacing: Math.PI },
  expectedLength: Math.hypot(0.75, 0, 0.25),
};
