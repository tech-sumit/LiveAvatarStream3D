import type { Vec3 } from './types.js';

/**
 * Yaw (radians) to face `to` from `from`, about the vertical axis — the body `turn` primitive.
 *
 * Matches updateStation's travel-facing `Math.atan2(toStation.x, toStation.z)`
 * (avatarController.ts:495): +Z is the facing datum, +X turns the avatar toward its right.
 * When the Score authored an absolute angle the compiler passes it through directly (it never
 * calls this); this resolves the point-to-face case. Returns 0 for a degenerate (zero-length)
 * delta — i.e. "keep facing forward".
 */
export function turnToward(from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  if (dx === 0 && dz === 0) return 0;
  return Math.atan2(dx, dz);
}
