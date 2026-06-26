import { describe, it, expect } from 'vitest';
import { aimEye } from './aimEye.js';
import type { EyeAim, Quat } from './types.js';
import {
  EYE_BEHIND,
  EYE_FORWARD,
  EYE_RIGHT,
  EYE_UP_RIGHT,
  GAZE_MAX_ANGLE,
} from './__fixtures__/regression.js';

const QUAT_TOL = 9;

function expectQuat(actual: Quat, expected: Quat): void {
  expect(actual[0]).toBeCloseTo(expected[0], QUAT_TOL);
  expect(actual[1]).toBeCloseTo(expected[1], QUAT_TOL);
  expect(actual[2]).toBeCloseTo(expected[2], QUAT_TOL);
  expect(actual[3]).toBeCloseTo(expected[3], QUAT_TOL);
}

// Pins applyGaze's clamp (maxAngle 0.5) + weight (0.85) + forward gate — the `look` primitive,
// previously untested. The avatar-live morph weight is recoverable as |aimAngle| / maxAngle.
describe('aimEye — regression parity with applyGaze clamp/weight', () => {
  it('reproduces the right-look quat and morph weight (hA clamped → hw 0.85)', () => {
    const eye = aimEye(EYE_RIGHT.input.dir);
    expectQuat(eye.quat, EYE_RIGHT.expected.quat);
    // EYE_RIGHT is a pure-yaw aim (vw 0) → yawAngle = 2·atan2(q.y, q.w); hw = |yaw| / maxAngle.
    const yaw = 2 * Math.atan2(eye.quat[1], eye.quat[3]);
    expect(Math.abs(yaw) / GAZE_MAX_ANGLE).toBeCloseTo(EYE_RIGHT.expected.hw, 9);
  });

  it('reproduces the up-right look quat (both axes clamped/weighted)', () => {
    const eye = aimEye(EYE_UP_RIGHT.input.dir);
    expectQuat(eye.quat, EYE_UP_RIGHT.expected.quat);
  });

  it('produces identity for a straight-ahead target', () => {
    const eye = aimEye(EYE_FORWARD.input.dir);
    expectQuat(eye.quat, EYE_FORWARD.expected.quat);
  });

  it('gates to identity for a target behind the head (f ≤ 0.05)', () => {
    const eye = aimEye(EYE_BEHIND.input.dir);
    expectQuat(eye.quat, EYE_BEHIND.expected.quat);
  });

  it('out-param call writes into the supplied EyeAim and matches the allocating call', () => {
    const alloc = aimEye(EYE_RIGHT.input.dir);
    const out: EyeAim = { quat: [0, 0, 0, 1] };
    const written = aimEye(EYE_RIGHT.input.dir, undefined, out);
    expect(written).toBe(out);
    expectQuat(out.quat, alloc.quat);
  });
});
