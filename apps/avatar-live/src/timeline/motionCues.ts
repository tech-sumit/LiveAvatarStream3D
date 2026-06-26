// ─────────────────────────────────────────────────────────────────────────────
// motionCues — the PURE (THREE-free) motion-cue vocabulary shared by the timeline
// player (`catalog.applyMotion`, the silent preview rehearsal) and the unified
// score.drive path (`buildNarrationPerformance`). Keeping the turn-yaw constants in
// ONE place means the two consumers can't drift: a `motion.turnScreen` cue resolves to
// the SAME setTurn(0.6) whether it fires via the preview player or the Performance
// `turns` channel on the live/export clock.
//
// This module imports nothing heavy (no THREE / AvatarController), so the headless
// `scoreDrive` parity path can consume it without pulling in WebGL.
// ─────────────────────────────────────────────────────────────────────────────

// Avatar-relative turn toward the studio screen (it's behind, so a partial turn reads
// as "addressing the wall"). +radians = turn the avatar's right shoulder back.
export const SCREEN_TURN = 0.6;

/**
 * The turn yaw a motion cue commands, or `undefined` if the cue doesn't turn the avatar.
 * The single source of truth for both `applyMotion` (preview) and the Performance `turns`
 * channel (the unified take/export drive), so the encodings cannot diverge.
 */
export function motionCueTurn(type: string): number | undefined {
  switch (type) {
    case 'motion.turnScreen':
      return SCREEN_TURN;
    case 'motion.faceFront':
      return 0;
    case 'motion.point':
      return SCREEN_TURN * 0.7;
    default:
      return undefined;
  }
}
