import type { EyeAim, Vec3 } from './types.js';
import { notImplemented } from './_stub.js';

/** Head-local eye aim toward `targetDir` (the `look` primitive); clamped by `maxAngle`. */
export function aimEye(
  targetDir: Vec3,
  opts?: { maxAngle?: number; weight?: number },
  out?: EyeAim,
): EyeAim {
  return notImplemented('aimEye', { targetDir, opts, out });
}
