import { describe, it, expect } from 'vitest';
import { resolveGesture } from '@las/performer-core';
import { Stage } from './stage.js';
import { Score, AudioTimings, GestureKind } from './score.js';
import { Performance } from './performance.js';
import { compileScore, compileNewsReportToScore, newsReportAudio } from './scoreCompile.js';
import { GESTURE_KIND_TO_CLIP } from './presets.js';
import { NewsReportDoc } from './newsreport.js';
import { compileNewsReport } from './newsreportCompile.js';

// ── Golden fixture ────────────────────────────────────────────────────────────
const STAGE = Stage.parse({
  id: 'studio_a',
  marks: [
    { id: 'center', pos: [0, 0, 0] },
    { id: 'left_of_screen', pos: [-1.5, 0, 0.4], facing: 'screen' },
  ],
  targets: [{ id: 'screen', kind: 'point', pos: [-3, 2, -2] }],
  savedShots: [{ id: 'hero', pose: { pos: [1, 1.6, 5], target: [0, 1.5, 0], fov: 28 } }],
});

const SCORE = Score.parse({
  stage: 'studio_a',
  defaults: { emotion: 'neutral', gait: 'walk' },
  beats: [
    {
      text: 'Welcome to the show',
      emotion: 'warm',
      cues: [
        { move: { to: 'left_of_screen' } },
        { at: { word: 2 }, look: { at: 'screen' } },
        { camera: { frame: { subjects: ['self.face', 'screen'] }, follow: true } },
      ],
      pauseMsAfter: 300,
    },
    {
      text: 'And here is the news',
      cues: [
        { gesture: { kind: 'point', target: 'screen' } },
        { at: { word: 1 }, emote: { emotion: 'excited', intensity: 0.7 } },
        { camera: { move: 'dolly', amount: -0.5, ease: 'ease_in_out' } },
        { turn: { to: 'screen' } },
        { camera: { shot: 'hero' } },
      ],
    },
  ],
});

const TIMINGS = AudioTimings.parse({
  beats: [
    {
      startSec: 0,
      endSec: 3,
      words: [
        { word: 'Welcome', startSec: 0, endSec: 0.5 },
        { word: 'to', startSec: 0.5, endSec: 1.0 },
        { word: 'the', startSec: 1.0, endSec: 1.5 },
        { word: 'show', startSec: 1.5, endSec: 3.0 },
      ],
    },
    {
      startSec: 3,
      endSec: 6,
      words: [
        { word: 'And', startSec: 3.0, endSec: 3.5 },
        { word: 'here', startSec: 3.5, endSec: 4.0 },
        { word: 'is', startSec: 4.0, endSec: 4.5 },
        { word: 'the', startSec: 4.5, endSec: 5.0 },
        { word: 'news', startSec: 5.0, endSec: 6.0 },
      ],
    },
  ],
});

describe('compileScore (golden)', () => {
  const perf = compileScore(STAGE, SCORE, TIMINGS);

  it('produces a valid Performance that round-trips through the schema', () => {
    expect(() => Performance.parse(perf)).not.toThrow();
    expect(perf.stageId).toBe('studio_a');
    expect(perf.durationSec).toBe(6);
  });

  it('emits a motion path with arrival facing from Mark.facing', () => {
    expect(perf.motion).toHaveLength(1);
    const mp = perf.motion[0]!;
    expect(mp.startSec).toBe(0);
    expect(mp.endSec).toBe(3);
    expect(mp.from).toEqual([0, 0, 0]);
    expect(mp.to).toEqual([-1.5, 0, 0.4]);
    expect(mp.gait).toBe('walk');
    // facing the screen target from the destination mark
    expect(mp.arriveFacing).toBeCloseTo(-2.582993, 5);
  });

  it('emits a follow two-shot camera keyframe with late-bound subjects', () => {
    // camera[0] is the follow two-shot (frame), camera[1] the dolly move, camera[2] the savedShot.
    const cam0 = perf.camera[0]!;
    expect(cam0.tSec).toBe(0);
    expect(cam0.follow).toBe(true);
    expect(cam0.pos[0]).toBeCloseTo(-2.6, 6);
    expect(cam0.pos[1]).toBeCloseTo(1.75, 6);
    expect(cam0.pos[2]).toBeCloseTo(8.730866, 5);
    expect(cam0.target[0]).toBeCloseTo(-1.4, 6);
    expect(cam0.fov).toBe(40);
    // self.face → late-bound BodyRef; screen → static pos.
    expect(cam0.followSubjects).toEqual([{ bind: 'face' }, { pos: [-3, 2, -2] }]);
  });

  it('emits a relative move camera keyframe (no absolute pose)', () => {
    const move = perf.camera.find((c) => c.move === 'dolly')!;
    expect(move.tSec).toBe(3);
    expect(move.moveAmount).toBe(-0.5);
    expect(move.ease).toBe('ease_in_out');
  });

  it('emits a savedShot camera keyframe verbatim', () => {
    const shot = perf.camera.find((c) => c.fov === 28)!;
    expect(shot.pos).toEqual([1, 1.6, 5]);
    expect(shot.target).toEqual([0, 1.5, 0]);
    expect(shot.follow).toBe(false);
  });

  it('emits a resolved turn from a target ref', () => {
    expect(perf.turns).toHaveLength(1);
    const turn = perf.turns[0]!;
    expect(turn.tSec).toBe(3);
    // facing the screen from the avatar's post-move position (left_of_screen)
    expect(turn.yaw).toBeCloseTo(-2.582993, 5);
  });

  it('emits a resolved gesture with IK drive + baseEnergy + late-bound target', () => {
    expect(perf.gestures).toHaveLength(1);
    const g = perf.gestures[0]!;
    expect(g.kind).toBe('point');
    expect(g.drive.kind).toBe('ik');
    expect(g.drive.ik).toBe('aim');
    // baseEnergy survives serialization (the determinism-fix field)
    expect(g.drive.baseEnergy).toBe('med'); // beat1 emotion defaults to neutral → med
    expect(g.target).toEqual({ pos: [-3, 2, -2] });
  });

  it('emits a look that tracks a static target', () => {
    expect(perf.looks).toHaveLength(1);
    const look = perf.looks[0]!;
    expect(look.tSec).toBe(1.0); // word index 2 = "the"@1.0
    expect(look.target).toEqual({ pos: [-3, 2, -2] });
  });

  it('emits a mid-beat emote anchor with intensity', () => {
    expect(perf.emotes).toHaveLength(1);
    const em = perf.emotes[0]!;
    expect(em.tSec).toBe(3.5); // word index 1 = "here"@3.5
    expect(em.emotion).toBe('excited');
    expect(em.intensity).toBe(0.7);
  });

  it('emits the 2D-safe per-beat projection', () => {
    expect(perf.beats).toHaveLength(2);
    const b0 = perf.beats[0]!;
    expect(b0.emotion).toBe('warm');
    expect(b0.gesture).toBe('none');
    expect(b0.posture).toBe('relaxed'); // warm → relaxed
    const b1 = perf.beats[1]!;
    expect(b1.emotion).toBe('neutral'); // beat1 inherits defaults.emotion
    expect(b1.gesture).toBe('point');
    expect(b1.intensity).toBe(0.7); // seeded by the emote anchor
  });
});

describe('compileScore (WordAnchor timing + out-of-range guard)', () => {
  it('lands a cue at exactly the anchored word startSec', () => {
    const perf = compileScore(STAGE, SCORE, TIMINGS);
    expect(perf.looks[0]!.tSec).toBe(1.0);
  });

  it('shifts nothing it should not — beat timing comes from AudioTimings', () => {
    const perf = compileScore(STAGE, SCORE, TIMINGS);
    expect(perf.beats[1]!.startSec).toBe(3);
  });

  it('clamps an out-of-range WordAnchor (no NaN, no throw)', () => {
    const score = Score.parse({
      stage: 'studio_a',
      beats: [{ text: 'hi there', cues: [{ at: { word: 999 }, look: { at: 'screen' } }] }],
    });
    const timings = AudioTimings.parse({
      beats: [{ startSec: 0, endSec: 2, words: [{ word: 'hi', startSec: 0, endSec: 1 }, { word: 'there', startSec: 1, endSec: 2 }] }],
    });
    const perf = compileScore(STAGE, score, timings);
    const t = perf.looks[0]!.tSec;
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBe(1); // clamped to last word's startSec
  });
});

describe('compileScore (determinism)', () => {
  it('is byte-identical across repeated runs', () => {
    const a = JSON.stringify(compileScore(STAGE, SCORE, TIMINGS));
    const b = JSON.stringify(compileScore(STAGE, SCORE, TIMINGS));
    expect(a).toBe(b);
  });
});

describe('clip-seam cross-check', () => {
  it('protocol GESTURE_KIND_TO_CLIP agrees with performer-core resolveGesture', () => {
    for (const kind of GestureKind.options) {
      const clip = GESTURE_KIND_TO_CLIP[kind];
      const drive = resolveGesture(kind);
      const driveClip = drive.kind === 'clip' ? (drive.clip ?? null) : null;
      expect(driveClip).toBe(clip);
    }
  });
});

// ── NewsReport → Score back-compat equivalence ────────────────────────────────
const DOC = NewsReportDoc.parse({
  version: 2,
  meta: { title: 'Evening Edition', anchors: [{ id: 'a1', name: 'Ava', avatarUrl: 'avaturn-model', voiceId: 'voice_ava' }] },
  look: { preset: 'noir', saturation: -1, contrast: 0.3 },
  defaults: { emotion: 'neutral', music: { src: '/samples/bed.mp3' } },
  rundown: [
    {
      id: 's1', slug: 'top', storyForm: 'READER', headline: 'Top story',
      beats: [
        { id: 'b1', text: 'Good evening', emotion: 'warm', gesture: 'wave', camera: { shot: 'close_up' } },
        { id: 'b2', text: 'Here is the news' },
      ],
    },
    {
      id: 's2', slug: 'two', storyForm: 'VO',
      beats: [{ id: 'b3', text: 'Markets rose today', emotion: 'confident', camera: { shot: 'wide' } }],
    },
  ],
});

function timingsFor(score: Score): AudioTimings {
  // synthetic 1s-per-beat timings so compileScore has a clock
  return AudioTimings.parse({
    beats: score.beats.map((b, i) => ({
      startSec: i,
      endSec: i + 1,
      words: b.text.split(/\s+/).filter(Boolean).map((w, wi) => ({ word: w, startSec: i + wi * 0.1, endSec: i + wi * 0.1 + 0.1 })),
    })),
  });
}

describe('compileNewsReportToScore (bridge + equivalence)', () => {
  const score = compileNewsReportToScore(DOC);

  it('lowers to a valid Score that compiles cleanly', () => {
    expect(() => Score.parse(score)).not.toThrow();
    const stage = Stage.parse({ id: 'newsroom', marks: [{ id: 'center', pos: [0, 0, 0] }] });
    const perf = compileScore(stage, score, timingsFor(score));
    expect(() => Performance.parse(perf)).not.toThrow();
  });

  it('preserves the camera buckets of the NewsReport path', () => {
    // beat1 close_up → cu, section2 wide → wide; the medium default opens.
    const sizes = score.beats.flatMap((b) =>
      b.cues.flatMap((c) => ('camera' in c && 'frame' in c.camera && c.camera.frame.size ? [c.camera.frame.size] : [])),
    );
    expect(sizes).toContain('cu');
    expect(sizes).toContain('wide');
  });

  it('preserves the per-beat emotion + gesture montage', () => {
    expect(score.beats[0]!.emotion).toBe('warm');
    expect(score.beats[2]!.emotion).toBe('confident');
    const gestures: GestureKind[] = score.beats.flatMap((b) =>
      b.cues.flatMap((c) => ('gesture' in c ? [c.gesture.kind] : [])),
    );
    expect(gestures).toContain('wave'); // b1 wave (snake→camel preserved)
  });

  it('carries music beds / SFX through newsReportAudio', () => {
    const audio = newsReportAudio(DOC, 3);
    const bed = audio.find((a) => a.label === 'music bed');
    expect(bed?.src).toBe('/samples/bed.mp3');
    expect(bed?.duration).toBe(3);
    // and they flow into Performance.audio
    const stage = Stage.parse({ id: 'newsroom', marks: [{ id: 'center', pos: [0, 0, 0] }] });
    const perf = compileScore(stage, score, timingsFor(score), undefined, { audio });
    expect(perf.audio.some((a) => a.label === 'music bed')).toBe(true);
  });

  it('agrees with compileNewsReport on the camera-bucket sequence + audio', () => {
    const legacy = compileNewsReport(DOC);
    const legacyCamTypes = legacy.cues.filter((c) => c.track === 'camera').map((c) => c.type);
    // legacy: cam.close (b1), cam.wide (s2). Score path: cu, wide.
    expect(legacyCamTypes).toEqual(['cam.close', 'cam.wide']);
    const scoreSizes = score.beats.flatMap((b) =>
      b.cues.flatMap((c) => ('camera' in c && 'frame' in c.camera && c.camera.frame.size ? [c.camera.frame.size] : [])),
    );
    expect(scoreSizes).toEqual(['cu', 'wide']);
    // audio: legacy emits a music bed; the Score path carries the same.
    const legacyBed = legacy.cues.find((c) => c.track === 'audio' && c.label === 'music bed');
    const audio = newsReportAudio(DOC, legacy.project.timeline.duration);
    const bed = audio.find((a) => a.label === 'music bed');
    expect(bed?.src).toBe(legacyBed?.src);
  });
});
