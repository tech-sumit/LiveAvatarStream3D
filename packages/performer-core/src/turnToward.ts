import type { Vec3 } from './types.js';
import { notImplemented } from './_stub.js';

/** Yaw (radians) to face `to` from `from` — drives the body turn primitive. */
export function turnToward(from: Vec3, to: Vec3): number {
  return notImplemented('turnToward', { from, to });
}
