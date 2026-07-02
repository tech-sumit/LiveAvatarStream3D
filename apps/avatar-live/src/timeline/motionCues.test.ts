import { describe, it, expect } from 'vitest';
import { motionCueTurn, SCREEN_TURN } from './motionCues.js';

// ─────────────────────────────────────────────────────────────────────────────
// motionCues characterization — the shared turn-yaw vocabulary consumed by BOTH
// the timeline preview player (catalog.applyMotion) and the unified score.drive
// `turns` channel. These pins are the drift alarm: if a yaw constant changes,
// every existing newscast's staging changes with it, live AND export.
// ─────────────────────────────────────────────────────────────────────────────

describe('motionCueTurn — turning cue types', () => {
  it('SCREEN_TURN is pinned at 0.6 rad (the "address the wall" partial turn)', () => {
    expect(SCREEN_TURN).toBe(0.6);
  });

  it('motion.turnScreen commands the full screen turn', () => {
    expect(motionCueTurn('motion.turnScreen')).toBe(SCREEN_TURN);
  });

  it('motion.faceFront commands yaw 0 (back to camera)', () => {
    expect(motionCueTurn('motion.faceFront')).toBe(0);
  });

  it('motion.point commands a partial (70%) screen turn', () => {
    // Pointing turns most of the way toward the wall but keeps the face open to
    // camera — pinned as exactly SCREEN_TURN * 0.7.
    expect(motionCueTurn('motion.point')).toBe(SCREEN_TURN * 0.7);
  });
});

describe('motionCueTurn — non-turning cue types return undefined', () => {
  // undefined means "don't touch the yaw" — applyMotion must NOT call setTurn for
  // these, so a wave/nod during a screen address does not snap the avatar frontal.
  const NON_TURNING = ['motion.wave', 'motion.nod', 'motion.explain'];
  for (const type of NON_TURNING) {
    it(`${type} does not turn`, () => {
      expect(motionCueTurn(type)).toBeUndefined();
    });
  }

  it('unknown / non-motion cue types do not turn', () => {
    expect(motionCueTurn('motion.bogus')).toBeUndefined();
    expect(motionCueTurn('cam.close')).toBeUndefined();
    expect(motionCueTurn('')).toBeUndefined();
  });
});
