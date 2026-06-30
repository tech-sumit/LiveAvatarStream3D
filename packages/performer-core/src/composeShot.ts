import type { Composition, Pose, ShotSize, Subject, Vec3 } from './types.js';

// ── Framing presets (pin avatar-live's catalog.poseFor + stage.frameAnchorScreen) ──
//
// Each single-subject size carries: distance (absolute `dist` OR head-height-scaled
// `distHeads`), look-at drop (absolute `drop` OR `dropHeads`), `fov`, and absolute
// camera/target offsets from the subject's head centre. close/wide scale with the
// avatar's head height; `medium` reproduces the bespoke `cam.anchor` framing (absolute
// offsets — today's catalog.poseFor('cam.anchor') is already avatar-size independent),
// and `mcu` is a clean tween between them.
interface SizeSpec {
  distHeads?: number;
  dist?: number;
  dropHeads?: number;
  drop?: number;
  fov: number;
  camOff: Vec3; // added to camera pos (x,y,z)
  tgtOff: Vec3; // added to look-at target (x,y,z)
}

const SIZE_TABLE: Record<ShotSize, SizeSpec> = {
  // catalog.poseFor('cam.close'): pos.z = hc.z + hh*4.0, target.y = eye - hh*0.25, fov 30
  cu: { distHeads: 4.0, dropHeads: 0.25, fov: 30, camOff: [0, 0, 0], tgtOff: [0, 0, 0] },
  // a clean medium-close-up tween (no today-parity case; matches protocol CAMERA_SIZE_PRESET.mcu)
  mcu: { distHeads: 5.2, dropHeads: 0.3, fov: 32, camOff: [0, 0, 0], tgtOff: [0, 0, 0] },
  // catalog.poseFor('cam.anchor') (the default news medium / anchor-left set):
  // pos = (hc.x+0.7, eye+0.05, hc.z+5.2), target = (hc.x+0.85, eye-0.18, hc.z), fov 32.
  medium: { dist: 5.2, drop: 0.18, fov: 32, camOff: [0.7, 0.05, 0], tgtOff: [0.85, 0, 0] },
  // catalog.poseFor('cam.wide'): pos.z = hc.z + hh*9.0, target.y = eye - hh*1.1, fov 40
  wide: { distHeads: 9.0, dropHeads: 1.1, fov: 40, camOff: [0, 0, 0], tgtOff: [0, 0, 0] },
};

// ── Two-shot (multi-subject) constants — pin stage.frameAnchorScreen (stage.ts:176-196) ──
// dist = (spread + PAD) / (2*tan(fov/2)); camera offset 1.1 LEFT of the midpoint, raised to an
// absolute 1.75; look-at offset +0.1 x / absolute 1.25 y / +0.9 z; fov 40.
const TWO_SHOT_PAD = 2.75;
const TWO_SHOT_FOV = 40;
const TWO_SHOT_CAM_OFF_X = -1.1;
const TWO_SHOT_CAM_Y = 1.75;
const TWO_SHOT_TGT_OFF_X = 0.1;
const TWO_SHOT_TGT_Y = 1.25;
const TWO_SHOT_TGT_OFF_Z = 0.9;

const DEG = Math.PI / 180;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Orbit a camera position `(px,py,pz)` around the look-`target` by `azimuthDeg` (about
// world-Y: 0 = unchanged, + = toward +X / the anchor's right) then `elevationDeg` (camera
// pitch: + = higher / looking-down). Done in spherical coordinates around the target, so the
// radius (camera→target distance) is preserved exactly and az = el = 0 round-trips to the
// input — the CAMERA_* parity fixtures depend on that identity. Writes the orbited camera
// position into the reused `out3` tuple (no allocation, rule C).
function orbitAround(
  px: number,
  py: number,
  pz: number,
  tx: number,
  ty: number,
  tz: number,
  azimuthDeg: number,
  elevationDeg: number,
  out3: Vec3,
): Vec3 {
  const ox = px - tx;
  const oy = py - ty;
  const oz = pz - tz;
  const radius = Math.hypot(ox, oy, oz) || 1e-6;
  const az = Math.atan2(ox, oz) + azimuthDeg * DEG; // angle from +Z toward +X
  // clamp the resulting elevation just shy of the poles so cos(el) never collapses the frame
  const el = clamp(Math.asin(clamp(oy / radius, -1, 1)) + elevationDeg * DEG, -85 * DEG, 85 * DEG);
  const horiz = radius * Math.cos(el);
  out3[0] = tx + horiz * Math.sin(az);
  out3[1] = ty + radius * Math.sin(el);
  out3[2] = tz + horiz * Math.cos(az);
  return out3;
}

// Reused orbit scratch (rule C) — fully consumed by writePose before the next composeShot.
const _orbit: Vec3 = [0, 0, 0];

// Write scalar components into `out` in place when supplied (no allocation, cross-cutting
// rule C); only build fresh Vec3 tuples on the allocating (no-`out`) path. Applies the
// camera orbit (azimuth/elevation about the target) and carries `roll` (dutch) onto the Pose;
// all three default to 0 → trig-free identity that preserves today's framings.
function writePose(
  out: Pose | undefined,
  px: number,
  py: number,
  pz: number,
  tx: number,
  ty: number,
  tz: number,
  fov: number,
  azimuth = 0,
  elevation = 0,
  roll = 0,
): Pose {
  let cx = px;
  let cy = py;
  let cz = pz;
  if (azimuth !== 0 || elevation !== 0) {
    const o = orbitAround(px, py, pz, tx, ty, tz, azimuth, elevation, _orbit);
    cx = o[0];
    cy = o[1];
    cz = o[2];
  }
  if (out) {
    out.pos[0] = cx;
    out.pos[1] = cy;
    out.pos[2] = cz;
    out.target[0] = tx;
    out.target[1] = ty;
    out.target[2] = tz;
    out.fov = fov;
    out.roll = roll;
    return out;
  }
  return { pos: [cx, cy, cz], target: [tx, ty, tz], fov, roll };
}

// Resolve `composition.size` to a SizeSpec. A named preset reads the table; a NUMBER is a
// continuous count of head-heights of distance (so a move can interpolate tightness, e.g.
// push-in 7.0 → 4.2). The numeric drop curve keeps the face in the upper third and the fov
// comes from `lens` (default 32) — head-on, no offsets (orbit/roll add any angle).
function sizeSpecFor(size: Composition['size'], lens: number | undefined): SizeSpec {
  if (typeof size === 'number') {
    return { distHeads: size, dropHeads: size * 0.12, fov: lens ?? 32, camOff: [0, 0, 0], tgtOff: [0, 0, 0] };
  }
  return SIZE_TABLE[size ?? 'medium'];
}

/**
 * Absolute framing: compute the camera Pose that frames `subjects` per `composition`.
 *
 * Single subject → a head-and-shoulders / wide / anchor framing scaled by the subject's
 * head-height (`size`), with `balance` lead-room and `height` look-at bias. Two+ subjects →
 * a two-shot: midpoint + fit-distance from the subject spread + the news two-shot offset.
 *
 * Per-frame `follow` re-calls this through the reused `out` Pose (allocation budget,
 * cross-cutting rule C) — no allocation when `out` is supplied.
 */
export function composeShot(subjects: Subject[], composition: Composition, out?: Pose): Pose {
  const s0 = subjects[0];
  if (!s0) throw new Error('composeShot: at least one subject is required');

  const azimuth = composition.azimuth ?? 0;
  const elevation = composition.elevation ?? 0;
  const roll = composition.roll ?? 0;

  // Two-shot: frame the midpoint of the first two subjects, dollying so both fit.
  const s1 = subjects[1];
  if (s1) {
    const mx = (s0.pos[0] + s1.pos[0]) / 2;
    const mz = (s0.pos[2] + s1.pos[2]) / 2;
    const dx = s0.pos[0] - s1.pos[0];
    const dz = s0.pos[2] - s1.pos[2];
    const spread = Math.hypot(dx, dz);
    const fov = composition.lens ?? TWO_SHOT_FOV;
    const dist = (spread + TWO_SHOT_PAD) / (2 * Math.tan((fov * Math.PI) / 360));
    const camZ = Math.max(s0.pos[2], s1.pos[2]) + dist;
    const balance = composition.balance ?? 0;
    const heightBias = composition.height ?? 0;
    return writePose(
      out,
      mx + TWO_SHOT_CAM_OFF_X + balance,
      TWO_SHOT_CAM_Y,
      camZ,
      mx + TWO_SHOT_TGT_OFF_X,
      TWO_SHOT_TGT_Y + heightBias,
      mz + TWO_SHOT_TGT_OFF_Z,
      fov,
      azimuth,
      elevation,
      roll,
    );
  }

  // Single subject.
  const hh = s0.size ?? 1;
  const spec = sizeSpecFor(composition.size, composition.lens);
  const dist = spec.dist ?? (spec.distHeads ?? 0) * hh;
  const drop = spec.drop ?? (spec.dropHeads ?? 0) * hh;
  const fov = composition.lens ?? spec.fov;
  const balance = composition.balance ?? 0;
  const heightBias = composition.height ?? 0;
  const eyeX = s0.pos[0];
  const eyeY = s0.pos[1];
  const eyeZ = s0.pos[2];
  return writePose(
    out,
    eyeX + spec.camOff[0] + balance,
    eyeY + spec.camOff[1],
    eyeZ + dist + spec.camOff[2],
    eyeX + spec.tgtOff[0],
    eyeY - drop + heightBias + spec.tgtOff[1],
    eyeZ + spec.tgtOff[2],
    fov,
    azimuth,
    elevation,
    roll,
  );
}
