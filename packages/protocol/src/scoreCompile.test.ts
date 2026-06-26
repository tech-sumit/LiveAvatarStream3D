import { describe, it, expect } from 'vitest';
import { resolveGesture } from '@las/performer-core';
import { Stage } from './stage.js';
import { Score, AudioTimings, GestureKind } from './score.js';
import { Performance } from './performance.js';
import { compileScore, compileNewsReportToScore, newsReportAudio } from './scoreCompile.js';
import { GESTURE_KIND_TO_CLIP } from './presets.js';
import * as presets from './presets.js';
import { NewsReportDoc } from './newsreport.js';
import { compileNewsReport } from './newsreportCompile.js';
import { composeShot } from '@las/performer-core';

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

// ── g1 regression tests ───────────────────────────────────────────────────────

// g1[0]: section-relative section.audio start must be re-based to ABSOLUTE (sectionStart + a.start)
// byte-identically to compileNewsReport. Pre-fix newsReportAudio kept start=0.5 (section-relative).
describe('g1: newsReportAudio re-bases section audio to absolute (parity with compileNewsReport)', () => {
  const SFX_DOC = NewsReportDoc.parse({
    version: 2,
    meta: { title: 'X', anchors: [{ id: 'a1', name: 'Ava', avatarUrl: 'm', voiceId: 'v' }] },
    rundown: [
      // a non-trivial first section so section[1] starts well past t=0
      { id: 's1', slug: 'one', beats: [{ id: 'b1', text: 'Good evening everyone and welcome to the broadcast tonight' }] },
      {
        id: 's2',
        slug: 'two',
        beats: [{ id: 'b3', text: 'Markets rose today across the board' }],
        // section-relative start: 0.5s INTO section 2 (which itself starts several seconds in)
        audio: [{ id: 'sfx1', kind: 'sfx', src: '/sfx/whoosh.mp3', start: 0.5, duration: 1 }],
      },
    ],
  });

  it('matches compileNewsReport absolute start byte-for-byte and is NOT section-relative', () => {
    const legacy = compileNewsReport(SFX_DOC);
    const legacySfx = legacy.cues.find((c) => c.track === 'audio' && c.src === '/sfx/whoosh.mp3');
    expect(legacySfx).toBeDefined();
    const audio = newsReportAudio(SFX_DOC, legacy.project.timeline.duration);
    const sfx = audio.find((a) => a.src === '/sfx/whoosh.mp3');
    expect(sfx).toBeDefined();
    // byte-identical to the legacy absolute clock
    expect(sfx!.start).toBe(legacySfx!.start);
    // section[1] starts past t=0, so absolute start must be strictly greater than the 0.5 offset
    expect(sfx!.start).toBeGreaterThan(0.5);
    // pre-fix bug emitted the raw section-relative value
    expect(sfx!.start).not.toBe(0.5);
  });
});

// g1[1]: the default camera must only SEED the opening; after an authored camera cut, a
// camera-less beat must HOLD the last shot, not snap back to the default.
describe('g1: sticky default camera does not snap back after an authored camera', () => {
  it('keeps the authored close-up and emits NO default wide keyframe on a later camera-less beat', () => {
    const stage = Stage.parse({ id: 's', marks: [{ id: 'center', pos: [0, 0, 0] }] });
    const score = Score.parse({
      stage: 's',
      // default camera = wide
      defaults: { camera: { frame: { subjects: ['self.face'], size: 'wide' } } },
      beats: [
        // beat[0] authors an explicit close-up
        { text: 'first beat here', cues: [{ camera: { frame: { subjects: ['self.face'], size: 'cu' } } }] },
        // beat[1] authors NO camera — must hold the close-up, NOT revert to wide
        { text: 'second beat here', cues: [] },
      ],
    });
    const timings = AudioTimings.parse({
      beats: [
        { startSec: 0, endSec: 2, words: [{ word: 'first', startSec: 0, endSec: 1 }, { word: 'beat', startSec: 1, endSec: 2 }] },
        { startSec: 2, endSec: 4, words: [{ word: 'second', startSec: 2, endSec: 3 }, { word: 'beat', startSec: 3, endSec: 4 }] },
      ],
    });
    const perf = compileScore(stage, score, timings);
    // exactly one camera keyframe: the authored close-up. No default-wide seed anywhere.
    expect(perf.camera).toHaveLength(1);
    const cu = perf.camera[0]!;
    expect(cu.tSec).toBe(0);
    expect(cu.fov).toBe(30); // SIZE_TABLE.cu fov — proves it's the close-up, not the wide (fov 40)
    // and crucially nothing was emitted at beat[1].startSec (2s)
    expect(perf.camera.some((c) => c.tSec === 2)).toBe(false);
  });
});

// g1[2]: a node-bound Target (pos undefined, node set) must compile to a late-bound {node} ref,
// NOT silently to {pos:[0,0,0]}.
describe('g1: node-bound Target compiles to a late-bound {node} ref', () => {
  it('carries Target.node through instead of rooting at [0,0,0]', () => {
    const stage = Stage.parse({
      id: 's',
      marks: [{ id: 'center', pos: [0, 0, 0] }],
      targets: [{ id: 'newsAnchor', kind: 'anchorBody', node: 'spine' }], // no pos
    });
    const score = Score.parse({
      stage: 's',
      beats: [{ text: 'look over there now', cues: [{ at: { word: 1 }, look: { at: 'newsAnchor' } }] }],
    });
    const timings = AudioTimings.parse({
      beats: [{ startSec: 0, endSec: 2, words: [
        { word: 'look', startSec: 0, endSec: 0.5 },
        { word: 'over', startSec: 0.5, endSec: 1.0 },
        { word: 'there', startSec: 1.0, endSec: 1.5 },
        { word: 'now', startSec: 1.5, endSec: 2.0 },
      ] }],
    });
    const perf = compileScore(stage, score, timings);
    expect(perf.looks).toHaveLength(1);
    expect(perf.looks[0]!.target).toEqual({ node: 'spine' });
    // explicitly NOT the silent world-root fallback
    expect(perf.looks[0]!.target).not.toEqual({ pos: [0, 0, 0] });
  });
});

// g1[3]: a gesture's `amount` hint must flow to baseEnergy (via energyFromAmount), not be discarded.
describe('g1: gesture amount hint flows to baseEnergy', () => {
  function gestureEnergy(amount: number): string | undefined {
    const stage = Stage.parse({ id: 's', marks: [{ id: 'center', pos: [0, 0, 0] }] });
    const score = Score.parse({
      stage: 's',
      beats: [{ text: 'hello there friend', cues: [{ gesture: { kind: 'wave', amount } }] }],
    });
    const timings = AudioTimings.parse({
      beats: [{ startSec: 0, endSec: 2, words: [
        { word: 'hello', startSec: 0, endSec: 0.7 },
        { word: 'there', startSec: 0.7, endSec: 1.3 },
        { word: 'friend', startSec: 1.3, endSec: 2.0 },
      ] }],
    });
    return compileScore(stage, score, timings).gestures[0]!.drive.baseEnergy;
  }

  it('high amount → high energy, low amount → low energy (not byte-identical)', () => {
    expect(gestureEnergy(0.9)).toBe('high');
    expect(gestureEnergy(0.1)).toBe('low');
    expect(gestureEnergy(0.9)).not.toBe(gestureEnergy(0.1)); // pre-fix both were the same emotion bucket
  });
});

// g1[4]: the drifted protocol-side CAMERA_SIZE_PRESET was removed; composeShot's SIZE_TABLE is now
// the single source of truth for size→framing.
describe('g1: CAMERA_SIZE_PRESET removed; composeShot is the single source for size framing', () => {
  it('no longer exports CAMERA_SIZE_PRESET from the protocol public API', () => {
    expect((presets as Record<string, unknown>).CAMERA_SIZE_PRESET).toBeUndefined();
  });

  it("compileScore framing for size 'medium' matches composeShot exactly", () => {
    const stage = Stage.parse({
      id: 's',
      marks: [{ id: 'center', pos: [0, 0, 0] }],
      targets: [{ id: 'p', kind: 'point', pos: [2, 1, -3] }],
    });
    const score = Score.parse({
      stage: 's',
      beats: [{ text: 'frame me medium', cues: [{ camera: { frame: { subjects: ['p'], size: 'medium' } } }] }],
    });
    const timings = AudioTimings.parse({
      beats: [{ startSec: 0, endSec: 2, words: [
        { word: 'frame', startSec: 0, endSec: 0.7 },
        { word: 'me', startSec: 0.7, endSec: 1.3 },
        { word: 'medium', startSec: 1.3, endSec: 2.0 },
      ] }],
    });
    const perf = compileScore(stage, score, timings);
    const kf = perf.camera[0]!;
    const expected = composeShot([{ pos: [2, 1, -3] }], { size: 'medium' });
    expect(kf.pos).toEqual([expected.pos[0], expected.pos[1], expected.pos[2]]);
    expect(kf.target).toEqual([expected.target[0], expected.target[1], expected.target[2]]);
    expect(kf.fov).toBe(expected.fov);
  });
});
