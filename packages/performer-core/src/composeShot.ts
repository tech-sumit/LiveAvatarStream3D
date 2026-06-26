import type { Composition, Pose, Subject } from './types.js';
import { notImplemented } from './_stub.js';

/**
 * Absolute framing: compute the camera Pose that frames `subjects` per `composition`.
 * Per-frame `follow` writes into the reused `out` Pose (allocation budget, cross-cutting C).
 */
export function composeShot(subjects: Subject[], composition: Composition, out?: Pose): Pose {
  return notImplemented('composeShot', { subjects, composition, out });
}
