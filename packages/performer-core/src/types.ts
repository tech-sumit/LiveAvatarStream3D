// @las/performer-core — the plain-vector contract for the pure-math performance runtime.
//
// This package is framework-agnostic: NO three.js, NO zod, zero runtime deps. Everything in
// and out is plain numbers / tuples so the math is unit-testable with golden numeric fixtures
// and both the browser studio (avatar-live) and any future headless renderer can re-adopt the
// identical solvers. This file is the single source of `Vec3`/`Quat`/`ShotSize`/`GestureKind`/
// `Drive` for the math layer; `@las/protocol` re-derives compatible zod versions and the
// boundary contract is stated in the Phase 3 compiler.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

/** A subject the camera can frame: a world position + optional world head-height. */
export interface Subject {
  pos: Vec3;
  size?: number; // world head-height, used to scale framing
}

export type ShotSize = 'cu' | 'mcu' | 'medium' | 'wide';

export interface Composition {
  size?: ShotSize;
  height?: number; // look-at height bias
  balance?: number; // horizontal lead (-1 left .. +1 right)
  lens?: number; // fov override
  follow?: boolean; // recompute per-frame as subjects move
}

export type CameraMove = 'dolly' | 'orbit' | 'pan' | 'truck' | 'pedestal';

export interface Pose {
  pos: Vec3;
  target: Vec3;
  fov: number;
}

export interface PathSample {
  pos: Vec3;
  t: number; // normalized 0..1 along the path
}

export interface PathPlan {
  samples: PathSample[];
  length: number;
  gait: 'walk' | 'stride';
  speed: number;
  arriveFacing?: number; // yaw radians at the destination, when authored (Mark.facing)
}

export type Side = 'left' | 'right';

export interface LimbAim {
  upperArm: Quat; // parent-space local quat
  foreArm: Quat; // parent-space local quat
}

export interface EyeAim {
  quat: Quat; // head-local eye aim
}

export interface FingerCurls {
  curls: number[][]; // [finger][joint] radians about local X
}

export type GestureKind =
  | 'none'
  | 'wave'
  | 'point'
  | 'present'
  | 'count'
  | 'clasp'
  | 'nod'
  | 'openPalms'
  | 'thumbsUp'
  | 'shrug'
  | 'handToChest'
  | 'explain';

export interface GestureParams {
  target?: Vec3;
  hand?: 'auto' | Side;
  count?: number;
  hold?: number;
  amount?: number;
  seed?: number;
}

export type DriveKind = 'clip' | 'ik' | 'none';
export type BaseEnergy = 'low' | 'med' | 'high';

export interface Drive {
  kind: DriveKind;
  clip?: string;
  baseEnergy?: BaseEnergy;
  ik?: 'aim' | 'count';
}
