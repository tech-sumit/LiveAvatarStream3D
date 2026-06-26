import { compileScore } from '@las/protocol';
import type { Performance, Stage, Score, AudioTimings } from '@las/protocol';

// A small COMPILED Performance for the Phase 4c headless parity harness. It is built by
// running @las/protocol's real `compileScore` on a fixture Stage + Score + timings at test
// time — so the parity test proves ScoreDrive consumes the genuine compiler output (not a
// hand-rolled shape). It exercises every per-frame channel the parity test pins: a follow
// two-shot camera, timed gestures (talk-clip determinism), a turn, an emote, and a screen
// cut — over a 4 s, two-beat performance.

// Stage: a screen mark (the back-wall two-shot subject) + a mark the avatar turns toward.
const STAGE: Stage = {
  id: 'fixture-stage',
  marks: [{ id: 'screenMark', pos: [1.95, 1.62, -0.35] }],
  targets: [{ id: 'screen', kind: 'prop', pos: [1.95, 1.62, -0.35] }],
  cameras: [],
  lights: [],
  props: [],
  savedShots: [],
};

// Score: beat 0 frames a follow two-shot (self.root + the screen) and waves; beat 1 turns to
// the screen mark, points, and emotes excited. Deterministic — no time, no random.
const SCORE: Score = {
  stage: 'fixture-stage',
  defaults: { emotion: 'neutral' },
  beats: [
    {
      text: 'Welcome to the show.',
      emotion: 'warm',
      cues: [
        { camera: { frame: { subjects: ['self.root', 'screen'], size: 'medium' }, follow: true } },
        { gesture: { kind: 'wave' } },
      ],
    },
    {
      text: 'Look at this.',
      emotion: 'excited',
      cues: [
        { turn: { to: 'screenMark' } },
        { gesture: { kind: 'point', target: 'screen' } },
        { emote: { emotion: 'excited', intensity: 0.8 } },
      ],
    },
  ],
};

// Timings: two 2 s beats (no per-word anchors needed — the cues fire at beat starts).
const TIMINGS: AudioTimings = {
  beats: [
    { startSec: 0, endSec: 2, words: [] },
    { startSec: 2, endSec: 4, words: [] },
  ],
};

/**
 * The compiled fixture Performance. A windowed back-wall screen cut (2 s → 3 s, fully
 * inside the 4 s performance) is added through compileScore's `extra.screen` channel as
 * start/end marks (source 'screen' on, 'scene' off) — exactly the shape
 * buildNarrationPerformance emits for a timeline cue.
 */
export function fixturePerformance(): Performance {
  return compileScore(STAGE, SCORE, TIMINGS, undefined, {
    screen: [
      { tSec: 2, source: 'screen' },
      { tSec: 3, source: 'scene' },
    ],
  });
}
