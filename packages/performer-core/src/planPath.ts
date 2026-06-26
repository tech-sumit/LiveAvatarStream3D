import type { PathPlan, Vec3 } from './types.js';
import { notImplemented } from './_stub.js';

/** Plan a floor path from `from` to `to`, carrying `arriveFacing` (resolved from Mark.facing). */
export function planPath(
  from: Vec3,
  to: Vec3,
  opts?: { gait?: 'walk' | 'stride'; speed?: number; arriveFacing?: number },
): PathPlan {
  return notImplemented('planPath', { from, to, opts });
}
