import type { EyeAim, Quat, Vec3 } from './types.js';

// applyGaze constants (avatarController.ts:688-690): ~28° max eye travel, 0.85 morph weight.
const DEFAULT_MAX_ANGLE = 0.5;
const DEFAULT_WEIGHT = 0.85;
const FORWARD_GATE = 0.05; // applyGaze only aims when the target is in front (dir·fwd > 0.05)

const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/**
 * Head-local eye aim toward `targetDir` (the `look` primitive solver).
 *
 * Reproduces applyGaze's clamp + weight exactly: in the head-local frame fwd=(0,0,1),
 * up=(0,1,0), right=(1,0,0), so `f = dir.z`, `hA = atan2(dir.x, f)`, `vA = atan2(dir.y, f)`.
 * The aim is gated to the front (`f > 0.05`). Each axis is clamped to `maxAngle` and scaled by
 * `weight`, yielding `hAim = sign(hA)·min(|hA|,maxAngle)·weight` (and likewise `vAim`); the
 * normalized morph weight applyGaze applies is recoverable as `|hAim|/maxAngle`. The returned
 * quaternion is yaw(hAim) ∘ pitch(vAim); the InLeft/OutRight morph cross-wiring stays in the
 * avatar-live rig binding (Phase 4b). Out-param overload (cross-cutting rule C).
 */
export function aimEye(
  targetDir: Vec3,
  opts?: { maxAngle?: number; weight?: number },
  out?: EyeAim,
): EyeAim {
  const maxAngle = opts?.maxAngle ?? DEFAULT_MAX_ANGLE;
  const weight = opts?.weight ?? DEFAULT_WEIGHT;
  const quat: Quat = out ? out.quat : [0, 0, 0, 1];

  const len = Math.hypot(targetDir[0], targetDir[1], targetDir[2]) || 1;
  const dx = targetDir[0] / len;
  const dy = targetDir[1] / len;
  const f = targetDir[2] / len;

  if (f <= FORWARD_GATE) {
    quat[0] = IDENTITY_QUAT[0];
    quat[1] = IDENTITY_QUAT[1];
    quat[2] = IDENTITY_QUAT[2];
    quat[3] = IDENTITY_QUAT[3];
    return out ?? { quat };
  }

  const hA = Math.atan2(dx, f);
  const vA = Math.atan2(dy, f);
  const hAim = Math.sign(hA) * Math.min(Math.abs(hA), maxAngle) * weight;
  const vAim = Math.sign(vA) * Math.min(Math.abs(vA), maxAngle) * weight;

  // q = yaw(hAim) * pitch(vAim), both about head-local axes (Y then X).
  const hy = hAim / 2;
  const sy = Math.sin(hy);
  const cy = Math.cos(hy);
  const hp = vAim / 2;
  const sp = Math.sin(hp);
  const cp = Math.cos(hp);
  // yawQuat = (0, sy, 0, cy); pitchQuat = (sp, 0, 0, cp); Hamilton product yaw * pitch.
  quat[0] = cy * sp; // x
  quat[1] = sy * cp; // y
  quat[2] = -sy * sp; // z
  quat[3] = cy * cp; // w
  return out ?? { quat };
}
