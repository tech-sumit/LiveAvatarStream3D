import * as THREE from 'three';
import { composeShot, moveCamera, aimLimb, aimEye, fingerCount, turnToward } from '@las/performer-core';
import type { CameraMove, Composition, Pose, Subject, Vec3, Quat, Side, EyeAim, FingerCurls } from '@las/performer-core';

// ─────────────────────────────────────────────────────────────────────────────
// coreAdapter — the ONLY place THREE ↔ @las/performer-core conversion happens.
//
// The live tick and the 30 fps offline export call the camera solvers every
// frame. To preserve avatar-live's allocation-free design (cross-cutting rule C),
// every per-frame helper here writes into MODULE-SCOPE reusable scratch — no `new`
// in the per-frame path. `composeShot`/`moveCamera` are invoked with their
// out-param overload (`out` = a reused Pose) so the math layer also never allocates.
//
// The framing math itself is the pure performer-core math; this file only marshals
// THREE.Vector3 / THREE.Quaternion ↔ plain tuples and applies the result to a Stage.
// The numbers are identical to the prior imperative catalog.poseFor /
// stage.frameAnchorScreen (proven by coreAdapter.parity.test.ts against the same
// formulas the performer-core Phase-2 regression fixtures pin).
// ─────────────────────────────────────────────────────────────────────────────

// Reusable plain-tuple scratch (performer-core side). The framing/move helpers write
// their result into a caller-supplied `out` Pose so two framings (e.g. the timeline
// from→to lerp) never alias one shared buffer.
const _subjA: Subject = { pos: [0, 0, 0], size: 1 };
const _subjB: Subject = { pos: [0, 0, 0], size: 1 };
const _subjects2: Subject[] = [_subjA, _subjB];
const _subjects1: Subject[] = [_subjA];
const _comp: Composition = {};
const _basePose: Pose = { pos: [0, 0, 0], target: [0, 0, 0], fov: 0 };

/** Allocate a fresh, zeroed Pose buffer (for module-scope scratch owned by a caller). */
export function makePose(): Pose {
  return { pos: [0, 0, 0], target: [0, 0, 0], fov: 0 };
}

// Reusable THREE scratch (THREE side) — mirrors avatarController's scratch pattern.
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();

/** Copy a THREE.Vector3 into a plain tuple (reused). */
export function toVec3(v: THREE.Vector3, out: Vec3): Vec3 {
  out[0] = v.x;
  out[1] = v.y;
  out[2] = v.z;
  return out;
}

/** Copy a THREE.Quaternion into a plain (x,y,z,w) tuple (reused). */
export function toQuat(q: THREE.Quaternion, out: Quat): Quat {
  out[0] = q.x;
  out[1] = q.y;
  out[2] = q.z;
  out[3] = q.w;
  return out;
}

/** Write a plain (x,y,z,w) tuple into a THREE.Quaternion. */
export function fromQuat(q: Quat, out: THREE.Quaternion): THREE.Quaternion {
  out.set(q[0], q[1], q[2], q[3]);
  return out;
}

/**
 * Apply a performer-core Pose to a Stage — the single THREE↔core write point.
 * Copies the tuple pose into module-scope THREE.Vector3 scratch, then calls
 * stage.setCameraPose (which owns the lookAt + fov apply). No per-frame allocation.
 */
export function applyPose(stage: { setCameraPose(pos: THREE.Vector3, target: THREE.Vector3, fov?: number): void }, pose: Pose): void {
  _v3a.set(pose.pos[0], pose.pos[1], pose.pos[2]);
  _v3b.set(pose.target[0], pose.target[1], pose.target[2]);
  stage.setCameraPose(_v3a, _v3b, pose.fov);
}

function copyComp(comp: Composition): void {
  _comp.size = comp.size;
  _comp.height = comp.height;
  _comp.balance = comp.balance;
  _comp.lens = comp.lens;
  _comp.follow = comp.follow;
}

/**
 * Frame a single subject (head centre + head height) per a Composition, writing the
 * result into `out` (allocation-free). Wraps composeShot's out-param overload.
 */
export function frameSubject(headCenter: THREE.Vector3, headHeight: number, comp: Composition, out: Pose): Pose {
  toVec3(headCenter, _subjA.pos);
  _subjA.size = headHeight;
  copyComp(comp);
  return composeShot(_subjects1, _comp, out);
}

/**
 * Frame two subjects as a two-shot (anchor + screen), writing into `out`. Wraps
 * composeShot's two-subject branch with its out-param overload. Only the x/z of each
 * subject affects the framing (matching stage.frameAnchorScreen), so y is irrelevant.
 */
export function frameTwoShot(anchor: THREE.Vector3, screen: THREE.Vector3, comp: Composition, out: Pose): Pose {
  toVec3(anchor, _subjA.pos);
  toVec3(screen, _subjB.pos);
  copyComp(comp);
  return composeShot(_subjects2, _comp, out);
}

/**
 * Relative camera op (truck / pedestal / dolly / pan / orbit) over a base pose
 * supplied as THREE vectors, writing into `out`. Reproduces stage.nudgeCamera's
 * local-axis deltas via performer-core's moveCamera. Allocation-free.
 */
export function moveFromThree(
  pos: THREE.Vector3,
  target: THREE.Vector3,
  fov: number,
  move: CameraMove,
  amount: number,
  out: Pose,
): Pose {
  _basePose.pos[0] = pos.x;
  _basePose.pos[1] = pos.y;
  _basePose.pos[2] = pos.z;
  _basePose.target[0] = target.x;
  _basePose.target[1] = target.y;
  _basePose.target[2] = target.z;
  _basePose.fov = fov;
  return moveCamera(_basePose, move, amount, out);
}

// ─────────────────────────────────────────────────────────────────────────────
// Motion / IK adapter glue (Phase 4b) — the THREE ↔ performer-core marshalling for
// the body solvers (aimLimb / aimEye / fingerCount / turnToward). The bone lookup +
// apply + smoothing stay in avatarController (avatar-specific rig binding); here we
// only convert THREE ↔ plain tuples and call the pure solvers, reusing module-scope
// scratch so nothing allocates per frame (cross-cutting rule C).
// ─────────────────────────────────────────────────────────────────────────────

// performer-core-side scratch (plain tuples / structs) reused every frame.
const _dirA: Vec3 = [0, 0, 0];
const _parentQ: Quat = [0, 0, 0, 1];
const _eyeDir: Vec3 = [0, 0, 0];
const _eyeAim: EyeAim = { quat: [0, 0, 0, 1] };

const GAZE_MAX_ANGLE = 0.5; // ~28° max eye travel (former applyGaze maxA)
const GAZE_OPTS: { maxAngle: number; weight: number } = { maxAngle: GAZE_MAX_ANGLE, weight: 0.85 };

/** Reusable FingerCurls buffer for fingerCount's out-param (per-frame, no alloc). */
export function makeFingerCurls(): FingerCurls {
  return { curls: [] };
}

/**
 * Two-bone arm aim through performer-core (replaces applyPointing's basis math).
 *
 * `shoulderToTarget` is the WORLD-space shoulder→target direction; `parentWorld` is the
 * arm bone's parent world quaternion (so the pure fn reproduces today's parent-space aim
 * exactly). Returns the auto-selected `side` and writes the desired PARENT-SPACE local
 * quats into the supplied THREE.Quaternions. Allocation-free.
 */
export function aimArm(
  shoulderToTarget: THREE.Vector3,
  parentWorld: THREE.Quaternion,
  side: Side | 'auto',
  outUpper: THREE.Quaternion,
  outFore: THREE.Quaternion,
  opts?: { weight?: number; foreArmWeight?: number },
): Side {
  toVec3(shoulderToTarget, _dirA);
  toQuat(parentWorld, _parentQ);
  const r = aimLimb(_dirA, _parentQ, side, opts);
  fromQuat(r.aim.upperArm, outUpper);
  fromQuat(r.aim.foreArm, outFore);
  return r.side;
}

/**
 * Eye-aim morph drive through performer-core (replaces applyGaze's atan2/clamp math).
 *
 * `dirLocal*` is the gaze direction already expressed in the avatar's local frame
 * (right=x, up=y, fwd=z) — matching applyGaze's `dir.dot(right/up/fwd)`. aimEye applies
 * the exact same front-gate (z>0.05), ±maxAngle clamp and weight; we decompose its
 * head-local yaw/pitch quaternion back into the normalized horizontal/vertical morph
 * weights applyGaze drives (`hw = |hAim|/maxAngle`, with the 0.85 weight already baked
 * into hAim). `hPos`/`vPos` carry the sign so the rig's InLeft/OutRight cross-wiring
 * (avatar-specific) stays in the controller. Allocation-free.
 */
export function gazeMorph(
  dirLocalX: number,
  dirLocalY: number,
  dirLocalZ: number,
  out: { hw: number; vw: number; hPos: boolean; vPos: boolean },
): { hw: number; vw: number; hPos: boolean; vPos: boolean } {
  _eyeDir[0] = dirLocalX;
  _eyeDir[1] = dirLocalY;
  _eyeDir[2] = dirLocalZ;
  // aimEye defaults: maxAngle 0.5 (~28°), weight 0.85 — the former applyGaze literals.
  const maxAngle = GAZE_MAX_ANGLE;
  aimEye(_eyeDir, GAZE_OPTS, _eyeAim);
  const q = _eyeAim.quat;
  // q = yaw(hAim) ∘ pitch(vAim): hAim = 2·atan2(q.y,q.w), vAim = 2·atan2(q.x,q.w).
  const hAim = 2 * Math.atan2(q[1], q[3]);
  const vAim = 2 * Math.atan2(q[0], q[3]);
  out.hw = Math.abs(hAim) / maxAngle; // 0.85 weight already folded into hAim
  out.vw = Math.abs(vAim) / maxAngle;
  out.hPos = hAim > 0;
  out.vPos = vAim > 0;
  return out;
}

/** Finger-count curls through performer-core, written into a reused FingerCurls. */
export function countFingers(n: number, t: number, out: FingerCurls, opts?: { phase?: number; curl?: number[] }): FingerCurls {
  return fingerCount(n, t, opts, out);
}

/** Yaw to face a plain-tuple target from a plain-tuple origin (move-path travel facing). */
export function yawTowardVec(from: Vec3, to: Vec3): number {
  return turnToward(from, to);
}
