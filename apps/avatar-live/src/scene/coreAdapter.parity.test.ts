import { describe, it, expect } from 'vitest';
import { composeShot, moveCamera } from '@las/performer-core';
import type { Pose, Vec3 } from '@las/performer-core';

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a camera-adapter PARITY tests.
//
// The avatar-live camera framing was refactored to produce poses via performer-core
// `composeShot` / `moveCamera` (through scene/coreAdapter.ts). This is a behavior-
// preserving refactor: the rendered camera must be IDENTICAL to the pre-refactor build.
//
// These tests are the proof. Each reproduces the EXACT former imperative formula from
// avatar-live (catalog.poseFor, scene/stage.frameAnchorScreen, scene/stage.nudgeCamera)
// inline, and asserts the new core math reproduces it to floating-point. They are pure-
// number node tests (no THREE, no DOM) so they run in plain vitest. The same numbers are
// independently pinned by performer-core's Phase-2 regression fixtures.
// ─────────────────────────────────────────────────────────────────────────────

const EPS = 1e-9;
function expectPose(got: Pose, exp: { pos: Vec3; target: Vec3; fov: number }): void {
  for (let i = 0; i < 3; i++) {
    expect(got.pos[i]).toBeCloseTo(exp.pos[i], 12);
    expect(got.target[i]).toBeCloseTo(exp.target[i], 12);
  }
  expect(Math.abs(got.fov - exp.fov)).toBeLessThanOrEqual(EPS);
}

// ── OLD catalog.poseFor (verbatim formulas for the composeShot-backed presets) ──
function oldPoseFor(type: 'cam.close' | 'cam.wide' | 'cam.anchor', hc: Vec3, hh: number): {
  pos: Vec3;
  target: Vec3;
  fov: number;
} {
  const eye = hc[1];
  switch (type) {
    case 'cam.close':
      return { pos: [hc[0], eye, hc[2] + hh * 4.0], target: [hc[0], eye - hh * 0.25, hc[2]], fov: 30 };
    case 'cam.wide':
      return { pos: [hc[0], eye, hc[2] + hh * 9.0], target: [hc[0], eye - hh * 1.1, hc[2]], fov: 40 };
    case 'cam.anchor':
      return { pos: [hc[0] + 0.7, eye + 0.05, hc[2] + 5.2], target: [hc[0] + 0.85, eye - 0.18, hc[2]], fov: 32 };
  }
}

const SIZE_OF: Record<'cam.close' | 'cam.wide' | 'cam.anchor', 'cu' | 'wide' | 'medium'> = {
  'cam.close': 'cu',
  'cam.wide': 'wide',
  'cam.anchor': 'medium',
};

describe('poseFor presets via composeShot (cam.close/wide/anchor)', () => {
  // Several avatar sizes + non-origin positions to stress the offsets/scaling.
  const cases: { hc: Vec3; hh: number }[] = [
    { hc: [0, 1.53, 0], hh: 0.42 }, // procedural-head defaults
    { hc: [0.3, 1.6, -0.2], hh: 0.5 },
    { hc: [-0.4, 1.45, 0.15], hh: 0.38 },
  ];
  for (const type of ['cam.close', 'cam.wide', 'cam.anchor'] as const) {
    for (const { hc, hh } of cases) {
      it(`${type} @ hc=${hc.join(',')} hh=${hh}`, () => {
        const got = composeShot([{ pos: hc, size: hh }], { size: SIZE_OF[type] });
        expectPose(got, oldPoseFor(type, hc, hh));
      });
    }
  }

  it('matches the Phase-2 regression pins for the procedural-head defaults', () => {
    const hc: Vec3 = [0, 1.53, 0];
    const hh = 0.42;
    expectPose(composeShot([{ pos: hc, size: hh }], { size: 'cu' }), { pos: [0, 1.53, 1.68], target: [0, 1.425, 0], fov: 30 });
    expectPose(composeShot([{ pos: hc, size: hh }], { size: 'wide' }), { pos: [0, 1.53, 3.78], target: [0, 1.068, 0], fov: 40 });
    expectPose(composeShot([{ pos: hc, size: hh }], { size: 'medium' }), { pos: [0.7, 1.58, 5.2], target: [0.85, 1.35, 0], fov: 32 });
  });
});

// ── OLD scene/stage.frameAnchorScreen (the computed two-shot target pose) ──
function oldTwoShot(anchor: Vec3, screen: Vec3): { pos: Vec3; target: Vec3; fov: number } {
  const mx = (anchor[0] + screen[0]) / 2;
  const mz = (anchor[2] + screen[2]) / 2;
  const spread = Math.hypot(anchor[0] - screen[0], anchor[2] - screen[2]);
  const fov = 40;
  const dist = (spread + 2.75) / (2 * Math.tan((fov * Math.PI) / 360));
  const camZ = Math.max(anchor[2], screen[2]) + dist;
  return { pos: [mx - 1.1, 1.75, camZ], target: [mx + 0.1, 1.25, mz + 0.9], fov };
}

describe('frameAnchorScreen two-shot via composeShot (follow, no balance)', () => {
  // The runtime SCREEN_STAND_POS = (1.95, 1.62, -0.35); the anchor walks. composeShot's
  // two-shot uses only x/z, so y is irrelevant — assert across several anchor positions.
  const screen: Vec3 = [1.95, 1.62, -0.35];
  const anchors: Vec3[] = [
    [0, 1.0, 0],
    [0.4, 1.0, 0.1],
    [-0.6, 1.0, -0.2],
    [1.0, 1.0, 0.5],
  ];
  for (const anchor of anchors) {
    it(`anchor=${anchor.join(',')}`, () => {
      const got = composeShot([{ pos: anchor }, { pos: screen }], { follow: true });
      expectPose(got, oldTwoShot(anchor, screen));
    });
  }

  it('matches the Phase-2 regression two-shot pin', () => {
    const got = composeShot([{ pos: [0, 0, 0] }, { pos: [0, 0, -2.55] }], { follow: true });
    expectPose(got, { pos: [-1.1, 1.75, 7.28081516155475], target: [0.1, 1.25, -0.375], fov: 40 });
  });
});

// ── OLD scene/stage.nudgeCamera (truck / pedestal / dolly local-axis deltas) ──
function oldNudge(pos: Vec3, target: Vec3, truck: number, pedestal: number, dolly: number): { pos: Vec3; target: Vec3 } {
  // fwd = target - pos; right = normalize(cross(fwd, up)); up = (0,1,0).
  const fx = target[0] - pos[0];
  const fy = target[1] - pos[1];
  const fz = target[2] - pos[2];
  const rx = fy * 0 - fz * 1;
  const ry = fz * 0 - fx * 0;
  const rz = fx * 1 - fy * 0;
  const rl = Math.hypot(rx, ry, rz) || 1;
  const panx = (rx / rl) * truck;
  const pany = (ry / rl) * truck + pedestal;
  const panz = (rz / rl) * truck;
  let px = pos[0] + panx;
  let py = pos[1] + pany;
  let pz = pos[2] + panz;
  const tx = target[0] + panx;
  const ty = target[1] + pany;
  const tz = target[2] + panz;
  if (dolly !== 0) {
    let ox = px - tx;
    let oy = py - ty;
    let oz = pz - tz;
    const len = Math.hypot(ox, oy, oz);
    const next = Math.max(0.2, len - dolly);
    const k = next / len;
    ox *= k;
    oy *= k;
    oz *= k;
    px = tx + ox;
    py = ty + oy;
    pz = tz + oz;
  }
  return { pos: [px, py, pz], target: [tx, ty, tz] };
}

describe('nudgeCamera relative moves via moveCamera (truck/pedestal/dolly)', () => {
  // The arrow-key path applies one axis per call; assert each in isolation across poses.
  const bases: { pos: Vec3; target: Vec3 }[] = [
    { pos: [0.5, 1.6, 3.0], target: [0.0, 1.4, 0.0] },
    { pos: [-1.1, 1.75, 7.28], target: [0.1, 1.25, -0.375] },
    { pos: [2.0, 2.0, 4.0], target: [-0.5, 1.2, 0.3] },
  ];
  const amounts = [0.05, 0.3, 1.0];
  for (const base of bases) {
    for (const a of amounts) {
      it(`truck ${a} @ ${base.pos.join(',')}`, () => {
        const got = moveCamera({ pos: base.pos, target: base.target, fov: 35 }, 'truck', a);
        const exp = oldNudge(base.pos, base.target, a, 0, 0);
        for (let i = 0; i < 3; i++) {
          expect(got.pos[i]).toBeCloseTo(exp.pos[i], 12);
          expect(got.target[i]).toBeCloseTo(exp.target[i], 12);
        }
      });
      it(`pedestal ${a} @ ${base.pos.join(',')}`, () => {
        const got = moveCamera({ pos: base.pos, target: base.target, fov: 35 }, 'pedestal', a);
        const exp = oldNudge(base.pos, base.target, 0, a, 0);
        for (let i = 0; i < 3; i++) {
          expect(got.pos[i]).toBeCloseTo(exp.pos[i], 12);
          expect(got.target[i]).toBeCloseTo(exp.target[i], 12);
        }
      });
      it(`dolly ${a} @ ${base.pos.join(',')}`, () => {
        const got = moveCamera({ pos: base.pos, target: base.target, fov: 35 }, 'dolly', a);
        const exp = oldNudge(base.pos, base.target, 0, 0, a);
        for (let i = 0; i < 3; i++) {
          expect(got.pos[i]).toBeCloseTo(exp.pos[i], 12);
          expect(got.target[i]).toBeCloseTo(exp.target[i], 12);
        }
      });
    }
  }
});
