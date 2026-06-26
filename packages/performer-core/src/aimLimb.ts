import type { LimbAim, Quat, Side, Vec3 } from './types.js';

// Pure-math replicas of the THREE ops avatarController.applyPointing uses (avatarController.ts:537-576),
// so this framework-agnostic fn reproduces the parent-space arm aim to the bit. Verified equal to
// three@0.152.2's Vector3.applyQuaternion + Matrix4.makeBasis + Quaternion.setFromRotationMatrix.

/** Rotate a vector by a unit quaternion (THREE.Vector3.applyQuaternion). */
function applyQuat(v: Vec3, q: Quat): Vec3 {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Quaternion from an orthonormal basis (columns X,Y,Z) — THREE.Quaternion.setFromRotationMatrix. */
function quatFromBasis(X: Vec3, Y: Vec3, Z: Vec3): Quat {
  // Column-major basis → rotation-matrix elements (rows m1*, m2*, m3*).
  const m11 = X[0];
  const m21 = X[1];
  const m31 = X[2];
  const m12 = Y[0];
  const m22 = Y[1];
  const m32 = Y[2];
  const m13 = Z[0];
  const m23 = Z[1];
  const m33 = Z[2];
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
}

const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/**
 * Two-bone arm aim. `targetDir` is the WORLD-space shoulder→target direction; `parentWorldQuat`
 * is the arm bone's parent world quaternion (supplied so this pure fn can reproduce today's
 * parent-space aiming exactly — a direction alone cannot, avatarController.ts:550). Returns the
 * desired PARENT-SPACE local quaternion for the upper arm whose +Y (down-the-bone for RPM arms)
 * points along the aim, plus an identity forearm target (the avatar-live rig slerps toward it to
 * straighten the forearm). The caller owns bone lookup, weighting and apply — not basis math.
 *
 * `side: 'auto'` selects `left` when the target is camera-right (+X, the screen's side, so the
 * arm never crosses the chest), `right` when camera-left. The `weight`/`foreArmWeight` opts are
 * carried for the adapter's slerp; they do not change the returned target quaternions.
 */
export function aimLimb(
  targetDir: Vec3,
  parentWorldQuat: Quat,
  side: Side | 'auto',
  opts?: { weight?: number; foreArmWeight?: number },
): { side: Side; aim: LimbAim } {
  // `opts` (slerp weights) are the adapter's concern (Phase 4b) — carried in the contract,
  // not baked into the returned target quaternions. Referenced here to document the boundary.
  void opts;
  const resolvedSide: Side = side === 'auto' ? (targetDir[0] >= 0 ? 'left' : 'right') : side;

  // Aim direction expressed in the bone's PARENT space (where its local quaternion lives).
  const parentInv: Quat = [-parentWorldQuat[0], -parentWorldQuat[1], -parentWorldQuat[2], parentWorldQuat[3]];
  const dir = normalize(applyQuat(normalize(targetDir), parentInv));

  // Build a basis whose +Y is the down-the-bone axis, with a stable up reference.
  const Y = dir;
  let Z: Vec3 = [0, 0, 1];
  if (Math.abs(Y[0] * Z[0] + Y[1] * Z[1] + Y[2] * Z[2]) > 0.99) Z = [1, 0, 0]; // avoid degeneracy
  const X = normalize(cross(Y, Z));
  Z = normalize(cross(X, Y));

  const upperArm = quatFromBasis(X, Y, Z);
  return { side: resolvedSide, aim: { upperArm, foreArm: [...IDENTITY_QUAT] as Quat } };
}
