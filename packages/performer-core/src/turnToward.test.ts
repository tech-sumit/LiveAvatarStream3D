import { describe, it, expect } from 'vitest';
import { turnToward } from './turnToward.js';
import { TURN_CASES } from './__fixtures__/regression.js';

// Pins updateStation's travel-facing atan2(toStation.x, toStation.z) (avatarController.ts:495):
// the cardinal/diagonal cases + "face the screen from a mark to its left".
describe('turnToward — regression parity with updateStation travel facing', () => {
  for (const c of TURN_CASES) {
    it(`from ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)} → ${c.expected.toFixed(4)} rad`, () => {
      expect(turnToward(c.from, c.to)).toBeCloseTo(c.expected, 10);
    });
  }

  it('returns 0 for a degenerate (zero-length XZ) delta', () => {
    expect(turnToward([1, 2, 3], [1, 9, 3])).toBe(0); // only Y differs
  });

  it('ignores the Y component (facing is a yaw)', () => {
    expect(turnToward([0, 0, 0], [1, 5, 0])).toBeCloseTo(Math.PI / 2, 10);
  });
});
