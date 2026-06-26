import type { PathPlan, PathSample, Vec3 } from './types.js';

// Default locomotion speed — STATION_SPEED (avatarController.ts:68). The walk/back speeds
// (1.15 / 0.75) become explicit `speed` arguments at the call site rather than enumerated paths.
const DEFAULT_SPEED = 1.2;
const SAMPLES_PER_METRE = 8; // sampling density for the straight-line floor path

/**
 * Plan a straight-line floor path from `from` to `to` on the XZ plane (Y carried through).
 *
 * Carries `{ length, gait, speed, arriveFacing }`: `arriveFacing` echoes the authored yaw
 * (resolved from Mark.facing) so "walk to a mark AND face the screen" survives — replacing the
 * hardcoded `turnTarget = 0` "face camera" datum in updateStation. Samples are monotone in `t`
 * (normalized 0..1) with exact endpoints. Pure / allocating — compile-time use only.
 */
export function planPath(
  from: Vec3,
  to: Vec3,
  opts?: { gait?: 'walk' | 'stride'; speed?: number; arriveFacing?: number },
): PathPlan {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  const gait = opts?.gait ?? 'walk';
  const speed = opts?.speed ?? DEFAULT_SPEED;

  // At least the two endpoints; otherwise one sample per ~1/8 m, plus the endpoint.
  const steps = Math.max(1, Math.ceil(length * SAMPLES_PER_METRE));
  const samples: PathSample[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    samples.push({ pos: [from[0] + dx * t, from[1] + dy * t, from[2] + dz * t], t });
  }

  const plan: PathPlan = { samples, length, gait, speed };
  if (opts?.arriveFacing !== undefined) plan.arriveFacing = opts.arriveFacing;
  return plan;
}
