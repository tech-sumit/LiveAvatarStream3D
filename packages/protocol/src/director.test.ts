import { describe, it, expect } from 'vitest';
import { buildDirectorSystemPrompt } from './director.js';
import { validateScore, AudioTimings, GestureKind, EmotionPreset, ShotSize } from './score.js';
import { Stage } from './stage.js';
import { Performance } from './performance.js';
import { compileScore } from './scoreCompile.js';

// The Stage the director's `stageId` refers to: a presenter mark + a screen target, the
// same default the avatar-live bridge lands a Score on (defaultStage in dispatch.ts).
const STAGE = Stage.parse({
  id: 'studio',
  marks: [{ id: 'center', pos: [0, 0, 0] }],
  targets: [{ id: 'screen', kind: 'point', pos: [1.95, 1.62, -0.35] }],
});

// A representative director output: a Score that references NAMED stage refs + NAMED presets
// (no raw camera coordinates), the shape the Score-emitting prompt asks the LLM to produce.
const DIRECTOR_SCORE = {
  stage: 'studio',
  defaults: { emotion: 'warm', gait: 'walk' },
  beats: [
    {
      text: 'Hello and welcome to the show',
      emotion: 'warm',
      cues: [
        { gesture: { kind: 'wave' } },
        { camera: { frame: { subjects: ['self.face'], size: 'mcu' }, follow: true } },
      ],
    },
    {
      text: 'Tonight we look at the big story',
      emotion: 'serious',
      cues: [
        { at: { word: 4 }, look: { at: 'screen' } },
        { gesture: { kind: 'point', target: 'screen' } },
        { at: { word: 2 }, emote: { emotion: 'concerned', intensity: 0.6 } },
        { camera: { frame: { subjects: ['self.face', 'screen'], size: 'wide' } } },
      ],
    },
  ],
};

const TIMINGS = AudioTimings.parse({
  beats: [
    { startSec: 0, endSec: 3, words: [] },
    { startSec: 3, endSec: 6, words: [] },
  ],
});

describe('buildDirectorSystemPrompt (Score-emitting)', () => {
  const prompt = buildDirectorSystemPrompt('A friendly evening-news anchor.', 'studio');

  it('asks for a single Score keyed to the given stage id', () => {
    expect(prompt).toContain('"stage": "studio"');
    expect(prompt).toContain('"beats"');
    // No longer the legacy JSONL streaming contract.
    expect(prompt).not.toContain('JSONL');
  });

  it('enumerates the Score preset vocabularies (presets over raw numbers)', () => {
    for (const e of EmotionPreset.options) expect(prompt).toContain(e);
    for (const g of GestureKind.options) expect(prompt).toContain(g);
    for (const s of ShotSize.options) expect(prompt).toContain(s);
    expect(prompt).toContain('self.face');
    expect(prompt).toContain('NEVER invent raw camera coordinates');
  });

  it('carries the persona through', () => {
    expect(prompt).toContain('A friendly evening-news anchor.');
  });
});

describe('director Score corpus', () => {
  it('a sampled director output parses via validateScore', () => {
    expect(() => validateScore(DIRECTOR_SCORE)).not.toThrow();
    const score = validateScore(DIRECTOR_SCORE);
    expect(score.stage).toBe('studio');
    expect(score.beats).toHaveLength(2);
  });

  it('compileScore runs clean on the sampled director output', () => {
    const score = validateScore(DIRECTOR_SCORE);
    const perf = compileScore(STAGE, score, TIMINGS);
    expect(() => Performance.parse(perf)).not.toThrow();
    expect(perf.stageId).toBe('studio');
    // wave (clip) + point (IK) → two resolved gestures; the bare frame + follow → camera keyframes.
    expect(perf.gestures.length).toBeGreaterThanOrEqual(2);
    expect(perf.camera.length).toBeGreaterThanOrEqual(2);
    // the mid-beat emote anchor compiled through
    expect(perf.emotes.length).toBeGreaterThanOrEqual(1);
    // the look cue resolved
    expect(perf.looks.length).toBeGreaterThanOrEqual(1);
  });
});
