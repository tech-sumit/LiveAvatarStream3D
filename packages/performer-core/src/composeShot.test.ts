import { describe, it, expect } from 'vitest';
import { composeShot } from './composeShot.js';
import type { Pose, Subject } from './types.js';
import {
  CAMERA_ANCHOR,
  CAMERA_CLOSE,
  CAMERA_TWO_SHOT,
  CAMERA_WIDE,
  type PoseFixture,
} from './__fixtures__/regression.js';

const POS_TOL = 1e-3; // ≤ 1 mm (plan Phase 2 Task 1)

function expectPose(actual: Pose, expected: PoseFixture): void {
  expect(actual.pos[0]).toBeCloseTo(expected.pos[0], 3);
  expect(actual.pos[1]).toBeCloseTo(expected.pos[1], 3);
  expect(actual.pos[2]).toBeCloseTo(expected.pos[2], 3);
  expect(actual.target[0]).toBeCloseTo(expected.target[0], 3);
  expect(actual.target[1]).toBeCloseTo(expected.target[1], 3);
  expect(actual.target[2]).toBeCloseTo(expected.target[2], 3);
  expect(actual.fov).toBe(expected.fov); // fov exact
}

// This is the acceptance gate for the Phase-4a camera swap: composeShot must reproduce
// every camera regression fixture (today's catalog.poseFor + stage.frameAnchorScreen).
describe('composeShot — regression parity with avatar-live framing', () => {
  it('reproduces catalog.poseFor cam.close (cu)', () => {
    const subj: Subject = { pos: CAMERA_CLOSE.input.hc, size: CAMERA_CLOSE.input.hh };
    expectPose(composeShot([subj], { size: 'cu' }), CAMERA_CLOSE.expected);
  });

  it('reproduces catalog.poseFor cam.wide (wide)', () => {
    const subj: Subject = { pos: CAMERA_WIDE.input.hc, size: CAMERA_WIDE.input.hh };
    expectPose(composeShot([subj], { size: 'wide' }), CAMERA_WIDE.expected);
  });

  it('reproduces catalog.poseFor cam.anchor (medium two-shot offset)', () => {
    const subj: Subject = { pos: CAMERA_ANCHOR.input.hc, size: CAMERA_ANCHOR.input.hh };
    expectPose(composeShot([subj], { size: 'medium' }), CAMERA_ANCHOR.expected);
  });

  it('reproduces stage.frameAnchorScreen two-shot (midpoint + fit-distance + offset)', () => {
    const anchor: Subject = { pos: CAMERA_TWO_SHOT.input.anchor };
    const screen: Subject = { pos: CAMERA_TWO_SHOT.input.screen };
    expectPose(composeShot([anchor, screen], {}), CAMERA_TWO_SHOT.expected);
  });

  it('out-param call returns the same numbers as the allocating call (pins the perf overload)', () => {
    const subj: Subject = { pos: CAMERA_CLOSE.input.hc, size: CAMERA_CLOSE.input.hh };
    const alloc = composeShot([subj], { size: 'cu' });
    const out: Pose = { pos: [0, 0, 0], target: [0, 0, 0], fov: 0 };
    const written = composeShot([subj], { size: 'cu' }, out);
    expect(written).toBe(out); // wrote into the supplied object (no allocation)
    expect(out.pos[0]).toBeCloseTo(alloc.pos[0], 10);
    expect(out.pos[1]).toBeCloseTo(alloc.pos[1], 10);
    expect(out.pos[2]).toBeCloseTo(alloc.pos[2], 10);
    expect(out.target[0]).toBeCloseTo(alloc.target[0], 10);
    expect(out.target[1]).toBeCloseTo(alloc.target[1], 10);
    expect(out.target[2]).toBeCloseTo(alloc.target[2], 10);
    expect(out.fov).toBe(alloc.fov);
  });

  it('balance adds horizontal lead room, height biases the look-at', () => {
    const subj: Subject = { pos: [0, 1.53, 0], size: 0.42 };
    const base = composeShot([subj], { size: 'cu' });
    const led = composeShot([subj], { size: 'cu', balance: 0.5, height: 0.2 });
    expect(led.pos[0] - base.pos[0]).toBeCloseTo(0.5, POS_TOL);
    expect(led.target[1] - base.target[1]).toBeCloseTo(0.2, POS_TOL);
  });

  it('throws when no subject is supplied', () => {
    expect(() => composeShot([], { size: 'cu' })).toThrow(/at least one subject/);
  });
});
