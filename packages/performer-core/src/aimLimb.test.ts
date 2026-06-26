import { describe, it, expect } from 'vitest';
import { aimLimb } from './aimLimb.js';
import type { Quat } from './types.js';
import {
  AIM_AUTO_LEFT_TARGET,
  AIM_DEGENERATE_Z,
  AIM_IDENTITY_PARENT,
  AIM_YAWED_PARENT,
} from './__fixtures__/regression.js';

const QUAT_TOL = 9; // ~1e-9: identical algorithm to three@0.152.2, so this is generous

function expectQuat(actual: Quat, expected: Quat): void {
  expect(actual[0]).toBeCloseTo(expected[0], QUAT_TOL);
  expect(actual[1]).toBeCloseTo(expected[1], QUAT_TOL);
  expect(actual[2]).toBeCloseTo(expected[2], QUAT_TOL);
  expect(actual[3]).toBeCloseTo(expected[3], QUAT_TOL);
}

// Pins the LeftArm/LeftForeArm parent-space aim quats (avatarController.applyPointing) so the
// Phase-4b adapter swap is provably equivalent — verified equal to three@0.152.2 (12 dp).
describe('aimLimb — regression parity with applyPointing parent-space aim', () => {
  it('reproduces the upper-arm quat for an identity parent (screen on the left, camera-right target)', () => {
    const f = AIM_IDENTITY_PARENT;
    const { side, aim } = aimLimb(f.input.targetDir, f.input.parentWorldQuat, 'auto');
    expect(side).toBe(f.expected.side);
    expectQuat(aim.upperArm, f.expected.upperArm);
    expectQuat(aim.foreArm, f.expected.foreArm); // identity forearm target
  });

  it('reproduces the upper-arm quat for a yawed parent (avatar turned 0.6 rad)', () => {
    const f = AIM_YAWED_PARENT;
    const { side, aim } = aimLimb(f.input.targetDir, f.input.parentWorldQuat, 'auto');
    expect(side).toBe(f.expected.side);
    expectQuat(aim.upperArm, f.expected.upperArm);
  });

  it('handles the degenerate near-+Z aim via the up-reference swap', () => {
    const f = AIM_DEGENERATE_Z;
    const { aim } = aimLimb(f.input.targetDir, f.input.parentWorldQuat, 'auto');
    expectQuat(aim.upperArm, f.expected.upperArm);
  });

  it("side:'auto' flips with the target azimuth (camera-left target → right arm)", () => {
    const f = AIM_AUTO_LEFT_TARGET;
    const { side } = aimLimb(f.input.targetDir, f.input.parentWorldQuat, 'auto');
    expect(side).toBe(f.expected.side); // 'right'
    // explicit side overrides auto-selection
    const forced = aimLimb(f.input.targetDir, f.input.parentWorldQuat, 'left');
    expect(forced.side).toBe('left');
  });

  it('returns a unit upper-arm quaternion', () => {
    const f = AIM_IDENTITY_PARENT;
    const { aim } = aimLimb(f.input.targetDir, f.input.parentWorldQuat, 'auto');
    const n = aim.upperArm[0] ** 2 + aim.upperArm[1] ** 2 + aim.upperArm[2] ** 2 + aim.upperArm[3] ** 2;
    expect(n).toBeCloseTo(1, 9);
  });
});
