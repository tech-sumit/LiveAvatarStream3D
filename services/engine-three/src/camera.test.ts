import { describe, it, expect } from 'vitest';
import { moveDelta, easeT, focalToFov, shotBasePosition } from './camera.js';

describe('camera mapping', () => {
  it('converts focal length to vertical FOV', () => {
    expect(focalToFov(50)).toBeGreaterThan(20);
    expect(focalToFov(50)).toBeLessThan(35);
  });

  it('dolly_in moves camera closer on X', () => {
    const { dPos } = moveDelta('dolly_in', 2.0, 1.0);
    expect(dPos.x).toBeLessThan(0);
  });

  it('ease_in_out is smooth at midpoint', () => {
    expect(easeT(0.5, 'ease_in_out')).toBeCloseTo(0.5, 1);
  });

  it('medium_close shot targets face height', () => {
    const { lookAt, fov } = shotBasePosition('medium_close', 'face', 0.5);
    expect(lookAt.y).toBeCloseTo(1.6, 1);
    expect(fov).toBeGreaterThan(0);
  });
});
