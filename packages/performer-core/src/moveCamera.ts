import type { CameraMove, Pose, Vec3 } from './types.js';

// World up — matches THREE.Camera.up default (0,1,0) used by stage.nudgeCamera.
const UP: Vec3 = [0, 1, 0];
const MIN_DOLLY_DIST = 0.2; // stage.nudgeCamera floors the dolly distance at 0.2 m

// Write scalar components into `out` in place when supplied (no allocation, cross-cutting
// rule C); only build fresh Vec3 tuples on the allocating (no-`out`) path.
function writePose(
  out: Pose | undefined,
  px: number,
  py: number,
  pz: number,
  tx: number,
  ty: number,
  tz: number,
  fov: number,
): Pose {
  if (out) {
    out.pos[0] = px;
    out.pos[1] = py;
    out.pos[2] = pz;
    out.target[0] = tx;
    out.target[1] = ty;
    out.target[2] = tz;
    out.fov = fov;
    return out;
  }
  return { pos: [px, py, pz], target: [tx, ty, tz], fov };
}

/**
 * Relative camera op applied to a base Pose by `amount`.
 *
 * `truck` / `pedestal` / `dolly` reproduce stage.nudgeCamera's local-axis deltas (truck =
 * strafe along camera-right; pedestal = world up; dolly>0 = move closer, distance floored at
 * 0.2 m). `pan` yaws the look-at about the camera (target-only). `orbit` is a NET-NEW arc:
 * rotate the camera about the target's vertical axis by `amount` radians, keeping the target.
 *
 * Out-param overload (cross-cutting rule C) — no allocation when `out` is supplied.
 */
export function moveCamera(base: Pose, move: CameraMove, amount: number, out?: Pose): Pose {
  const px = base.pos[0];
  const py = base.pos[1];
  const pz = base.pos[2];
  const tx = base.target[0];
  const ty = base.target[1];
  const tz = base.target[2];

  switch (move) {
    case 'truck': {
      // right = normalize(cross(fwd, up)); fwd = normalize(target - pos).
      const fx = tx - px;
      const fy = ty - py;
      const fz = tz - pz;
      const rx = fy * UP[2] - fz * UP[1];
      const ry = fz * UP[0] - fx * UP[2];
      const rz = fx * UP[1] - fy * UP[0];
      const rl = Math.hypot(rx, ry, rz) || 1;
      const ux = (rx / rl) * amount;
      const uy = (ry / rl) * amount;
      const uz = (rz / rl) * amount;
      return writePose(out, px + ux, py + uy, pz + uz, tx + ux, ty + uy, tz + uz, base.fov);
    }
    case 'pedestal': {
      // pan = (0, amount, 0); applied to both camera and target.
      return writePose(out, px, py + amount, pz, tx, ty + amount, tz, base.fov);
    }
    case 'dolly': {
      // off = pos - target; shorten by `amount` (floored at 0.2 m); pos = target + off.
      let ox = px - tx;
      let oy = py - ty;
      let oz = pz - tz;
      const len = Math.hypot(ox, oy, oz);
      const next = Math.max(MIN_DOLLY_DIST, len - amount);
      const k = len > 0 ? next / len : 0;
      ox *= k;
      oy *= k;
      oz *= k;
      return writePose(out, tx + ox, ty + oy, tz + oz, tx, ty, tz, base.fov);
    }
    case 'pan': {
      // Target-only yaw about the camera's vertical axis: rotate (target - pos) about Y.
      const dx = tx - px;
      const dz = tz - pz;
      const c = Math.cos(amount);
      const s = Math.sin(amount);
      const rdx = dx * c + dz * s;
      const rdz = -dx * s + dz * c;
      return writePose(out, px, py, pz, px + rdx, ty, pz + rdz, base.fov);
    }
    case 'orbit': {
      // Net-new arc: rotate the camera about the target's vertical axis, keeping the target.
      const dx = px - tx;
      const dz = pz - tz;
      const c = Math.cos(amount);
      const s = Math.sin(amount);
      const rdx = dx * c + dz * s;
      const rdz = -dx * s + dz * c;
      return writePose(out, tx + rdx, py, tz + rdz, tx, ty, tz, base.fov);
    }
  }
}
