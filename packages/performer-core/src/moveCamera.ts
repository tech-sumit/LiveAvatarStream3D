import type { CameraMove, Pose } from './types.js';
import { notImplemented } from './_stub.js';

/** Relative camera op (dolly/orbit/pan/truck/pedestal) applied to a base Pose by `amount`. */
export function moveCamera(base: Pose, move: CameraMove, amount: number, out?: Pose): Pose {
  return notImplemented('moveCamera', { base, move, amount, out });
}
