import type { CameraMove, CameraShot, CameraTarget } from '@las/protocol';
import { Vector3 } from 'three';

/** Mirrors services/engine/render_from_manifest.py SHOT_PARAMS / TARGET_HEIGHT. */
export const SHOT_PARAMS: Record<
  CameraShot,
  { focalMm: number; distance: number; height: number }
> = {
  wide: { focalMm: 24, distance: 4.0, height: 1.0 },
  full: { focalMm: 35, distance: 3.0, height: 0.95 },
  medium: { focalMm: 50, distance: 2.0, height: 1.2 },
  medium_close: { focalMm: 65, distance: 1.4, height: 1.45 },
  close_up: { focalMm: 85, distance: 1.0, height: 1.6 },
  extreme_close_up: { focalMm: 100, distance: 0.6, height: 1.62 },
};

export const TARGET_HEIGHT: Record<CameraTarget, number> = {
  eyes: 1.65,
  face: 1.6,
  chest: 1.3,
  torso: 1.1,
  full_body: 0.9,
};

/** Convert focal length (mm, full-frame) to vertical FOV for Three.js PerspectiveCamera. */
export function focalToFov(focalMm: number, sensorHeightMm = 24): number {
  return (2 * Math.atan(sensorHeightMm / (2 * focalMm)) * 180) / Math.PI;
}

export function shotBasePosition(
  shot: CameraShot,
  target: CameraTarget,
  _intensity: number,
): { position: Vector3; lookAt: Vector3; fov: number } {
  const { focalMm, distance } = SHOT_PARAMS[shot];
  const lookY = TARGET_HEIGHT[target];
  const lookAt = new Vector3(0, lookY, 0);
  // Camera sits in front of the subject along +Z (Three.js Y-up).
  const position = new Vector3(0, lookY, distance);
  return { position, lookAt, fov: focalToFov(focalMm) };
}

export function moveDelta(
  move: CameraMove,
  distance: number,
  intensity: number,
): { dPos: Vector3; dyawDeg: number } {
  const amt = Math.max(0, Math.min(1, intensity));
  const dPos = new Vector3();
  let dyawDeg = 0;
  switch (move) {
    case 'static':
      break;
    case 'dolly_in':
      dPos.x = -distance * 0.4 * amt;
      break;
    case 'dolly_out':
      dPos.x = distance * 0.4 * amt;
      break;
    case 'truck_left':
      dPos.y = -distance * 0.3 * amt;
      break;
    case 'truck_right':
      dPos.y = distance * 0.3 * amt;
      break;
    case 'pedestal_up':
      dPos.z = distance * 0.2 * amt;
      break;
    case 'pedestal_down':
      dPos.z = -distance * 0.2 * amt;
      break;
    case 'pan_left':
      dyawDeg = 12 * amt;
      break;
    case 'pan_right':
      dyawDeg = -12 * amt;
      break;
    case 'orbit_left':
      dyawDeg = 25 * amt;
      break;
    case 'orbit_right':
      dyawDeg = -25 * amt;
      break;
    default: {
      const _exhaustive: never = move;
      return _exhaustive;
    }
  }
  return { dPos, dyawDeg };
}

/** Smoothstep easing for camera interpolation. */
export function easeT(t: number, easing: string): number {
  const x = Math.max(0, Math.min(1, t));
  switch (easing) {
    case 'linear':
      return x;
    case 'ease_in':
      return x * x;
    case 'ease_out':
      return 1 - (1 - x) * (1 - x);
    case 'ease_in_out':
    default:
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  }
}
