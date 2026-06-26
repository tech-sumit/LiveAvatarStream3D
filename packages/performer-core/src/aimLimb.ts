import type { LimbAim, Quat, Side, Vec3 } from './types.js';
import { notImplemented } from './_stub.js';

/**
 * Two-bone arm aim. `parentWorldQuat` is supplied so this pure fn can reproduce today's
 * parent-space aiming exactly; `side: 'auto'` is chosen from the target direction's azimuth.
 */
export function aimLimb(
  targetDir: Vec3,
  parentWorldQuat: Quat,
  side: Side | 'auto',
  opts?: { weight?: number; foreArmWeight?: number },
): { side: Side; aim: LimbAim } {
  return notImplemented('aimLimb', { targetDir, parentWorldQuat, side, opts });
}
