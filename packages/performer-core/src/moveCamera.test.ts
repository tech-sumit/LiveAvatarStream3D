import { describe, it, expect } from 'vitest';
import { moveCamera } from './moveCamera.js';
import type { Pose, Vec3 } from './types.js';

const BASE: Pose = { pos: [2, 1.5, 5], target: [0, 1.5, 0], fov: 35 };

// Independent reference for stage.nudgeCamera's truck/pedestal/dolly (the parity cases).
function nudge(base: Pose, truck: number, pedestal: number, dolly: number): { pos: Vec3; target: Vec3 } {
  let pos: Vec3 = [...base.pos];
  let tgt: Vec3 = [...base.target];
  const fwd: Vec3 = [tgt[0] - pos[0], tgt[1] - pos[1], tgt[2] - pos[2]];
  const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
  const fn: Vec3 = [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl];
  const up: Vec3 = [0, 1, 0];
  let right: Vec3 = [fn[1] * up[2] - fn[2] * up[1], fn[2] * up[0] - fn[0] * up[2], fn[0] * up[1] - fn[1] * up[0]];
  const rl = Math.hypot(right[0], right[1], right[2]) || 1;
  right = [right[0] / rl, right[1] / rl, right[2] / rl];
  const pan: Vec3 = [right[0] * truck, right[1] * truck + pedestal, right[2] * truck];
  pos = [pos[0] + pan[0], pos[1] + pan[1], pos[2] + pan[2]];
  tgt = [tgt[0] + pan[0], tgt[1] + pan[1], tgt[2] + pan[2]];
  if (dolly !== 0) {
    let off: Vec3 = [pos[0] - tgt[0], pos[1] - tgt[1], pos[2] - tgt[2]];
    const ol = Math.hypot(off[0], off[1], off[2]) || 1;
    const nl = Math.max(0.2, ol - dolly);
    off = [(off[0] / ol) * nl, (off[1] / ol) * nl, (off[2] / ol) * nl];
    pos = [tgt[0] + off[0], tgt[1] + off[1], tgt[2] + off[2]];
  }
  return { pos, target: tgt };
}

function expectVec(actual: Vec3, expected: Vec3, dp = 10): void {
  expect(actual[0]).toBeCloseTo(expected[0], dp);
  expect(actual[1]).toBeCloseTo(expected[1], dp);
  expect(actual[2]).toBeCloseTo(expected[2], dp);
}

describe('moveCamera — truck/pedestal/dolly parity with stage.nudgeCamera', () => {
  it('truck strafes camera + target along camera-right', () => {
    const r = moveCamera(BASE, 'truck', 0.5);
    const ref = nudge(BASE, 0.5, 0, 0);
    expectVec(r.pos, ref.pos);
    expectVec(r.target, ref.target);
    expect(r.fov).toBe(35);
  });

  it('pedestal raises camera + target by the world up', () => {
    const r = moveCamera(BASE, 'pedestal', 0.3);
    const ref = nudge(BASE, 0, 0.3, 0);
    expectVec(r.pos, ref.pos);
    expectVec(r.target, ref.target);
  });

  it('dolly>0 moves the camera closer along (pos-target), target fixed', () => {
    const r = moveCamera(BASE, 'dolly', 1);
    const ref = nudge(BASE, 0, 0, 1);
    expectVec(r.pos, ref.pos);
    expectVec(r.target, ref.target); // unchanged
  });

  it('dolly floors the distance at 0.2 m', () => {
    const r = moveCamera(BASE, 'dolly', 100); // would overshoot through the target
    const off = Math.hypot(r.pos[0] - r.target[0], r.pos[1] - r.target[1], r.pos[2] - r.target[2]);
    expect(off).toBeCloseTo(0.2, 10);
  });
});

describe('moveCamera — pan / orbit', () => {
  it('pan yaws the look-at about the camera (target-only)', () => {
    const r = moveCamera(BASE, 'pan', 0.2);
    expectVec(r.pos, BASE.pos); // camera fixed
    const dx = BASE.target[0] - BASE.pos[0];
    const dz = BASE.target[2] - BASE.pos[2];
    const c = Math.cos(0.2);
    const s = Math.sin(0.2);
    expectVec(r.target, [BASE.pos[0] + dx * c + dz * s, BASE.target[1], BASE.pos[2] - dx * s + dz * c]);
  });

  it('orbit (net-new arc) rotates the camera about the target, keeping the target', () => {
    const r = moveCamera(BASE, 'orbit', Math.PI / 2);
    expectVec(r.target, BASE.target); // target fixed
    // offset (2,_,5) rotated +90° about Y → (5,_,-2); distance to target preserved.
    expectVec(r.pos, [5, 1.5, -2]);
    const d0 = Math.hypot(BASE.pos[0] - BASE.target[0], BASE.pos[2] - BASE.target[2]);
    const d1 = Math.hypot(r.pos[0] - r.target[0], r.pos[2] - r.target[2]);
    expect(d1).toBeCloseTo(d0, 10);
  });

  it('out-param call writes into the supplied Pose and matches the allocating call', () => {
    const alloc = moveCamera(BASE, 'orbit', 0.7);
    const out: Pose = { pos: [0, 0, 0], target: [0, 0, 0], fov: 0 };
    const written = moveCamera(BASE, 'orbit', 0.7, out);
    expect(written).toBe(out);
    expectVec(out.pos, alloc.pos);
    expectVec(out.target, alloc.target);
    expect(out.fov).toBe(alloc.fov);
  });
});
