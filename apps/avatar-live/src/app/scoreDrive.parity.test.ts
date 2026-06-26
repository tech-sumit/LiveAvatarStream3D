import { describe, it, expect } from 'vitest';
import { composeShot } from '@las/performer-core';
import type { Vec3 } from '@las/performer-core';
import type { Performance, SlideContent } from '@las/protocol';
import { ScoreDrive, buildNarrationPerformance, type Vec3Like, type StageLike, type AvatarLike, type ScreenAnchor } from './scoreDrive.js';
import type { MouthCue } from '../avatar/avatarController.js';
import type { EmotionName } from '../avatar/emotion.js';
import { fixturePerformance } from './__fixtures__/performance.fixture.js';

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4c — headless scoreDrive PARITY harness (the acceptance gate).
//
// The live narration tick and the offline export now run through ONE
// `score.drive(t, dt, mouth)`. This test proves they produce IDENTICAL commands by
// driving the SAME fixture Performance through the frame-stepped (export) clock and a
// simulated live clock against fake Stage/Avatar spies — NO WebGL / GLB / AudioContext
// (ScoreDrive depends only on the injected StageLike/AvatarLike interfaces, and the mouth
// is injected). It pins: command parity at fixed t; the multi-frame follow-damping
// trajectory (the snap-vs-0.45s-ease lag a boolean can't capture); selectTalkClip
// determinism across a live-then-export sequence (the actual reported divergence); and a
// per-frame allocation budget (rule C).
// ─────────────────────────────────────────────────────────────────────────────

const SILENT: MouthCue = { jawOpen: 0, mouthWide: 0, mouthRound: 0, mouthClose: 0 };
const SCREEN: Vec3Like = { x: 1.95, y: 1.62, z: -0.35 };
const TAU = 0.45; // the live follow time-constant (stage.ts:190) — shared by both clocks now.

// ── Fake stage: records camera/screen commands; models the REAL two-shot follow ──
// frameAnchorScreen reproduces Stage.frameAnchorScreen exactly: the two-shot pose comes
// from performer-core composeShot (follow:true), and the recorded camera is damped toward
// it by k = snap ? 1 : 1 - exp(-dt/0.45). This makes the headless fake a faithful model of
// the real follow term — the trajectory the parity test pins.
class FakeStage implements StageLike {
  camPos: Vec3 = [0, 1.5, 5];
  camTarget: Vec3 = [0, 1.5, 0];
  camFov = 35;
  camLog: { pos: Vec3; target: Vec3; fov: number }[] = [];
  snaps: boolean[] = []; // the snap flag passed to each frameAnchorScreen (frame-0 export snap pin)
  poses: { pos: Vec3; target: Vec3; fov?: number }[] = []; // authored setCameraPose calls
  screenCuts: { active: boolean }[] = [];
  seeks: number[] = [];
  private cam = { x: 0, y: 1.5, z: 5 };

  cameraWorldPosition(): Vec3Like {
    return { x: this.cam.x, y: this.cam.y, z: this.cam.z };
  }
  frameAnchorScreen(anchor: Vec3Like, screen: Vec3Like, dt: number, snap = false): void {
    this.snaps.push(snap);
    const pose = composeShot([{ pos: [anchor.x, anchor.y, anchor.z] }, { pos: [screen.x, screen.y, screen.z] }], { follow: true });
    if (Math.abs(this.camFov - pose.fov) > 0.01) this.camFov = pose.fov;
    const k = snap ? 1 : 1 - Math.exp(-dt / TAU);
    for (let i = 0; i < 3; i++) {
      this.camTarget[i] = lerp(this.camTarget[i] ?? 0, pose.target[i] ?? 0, k);
      this.camPos[i] = lerp(this.camPos[i] ?? 0, pose.pos[i] ?? 0, k);
    }
    this.cam = { x: this.camPos[0], y: this.camPos[1], z: this.camPos[2] };
    this.camLog.push({ pos: [...this.camPos] as Vec3, target: [...this.camTarget] as Vec3, fov: this.camFov });
  }
  setCameraPose(pos: Vec3Like, target: Vec3Like, fov?: number): void {
    // Copy (don't store the caller's reused scratch by reference) so the log is a faithful trace.
    this.poses.push({ pos: [pos.x, pos.y, pos.z], target: [target.x, target.y, target.z], fov });
  }
  seekScreen(t: number): void {
    this.seeks.push(t);
  }
  setScreenCut(active: boolean): void {
    this.screenCuts.push({ active });
  }
}

// ── Fake avatar: records the body/face commands; movable root for the follow test ──
class FakeAvatar implements AvatarLike {
  headCenter: Vec3Like = { x: 0, y: 1.5, z: 0 };
  headHeight = 0.42;
  group = { position: { x: 0, y: 0, z: 0 } };
  animationClips = ['idle', 'idle_calm', 'talk1', 'talk2', 'talk3', 'talk4', 'talk5', 'wave', 'point'];
  emotions: { name: EmotionName; intensity: number }[] = [];
  turns: number[] = [];
  gazes: (Vec3Like | null)[] = [];
  gestures: { gesture: string; base: string }[] = [];
  clips: string[] = [];
  mouths: MouthCue[] = [];
  updates: number[] = [];

  setMouth(cue: MouthCue): void {
    this.mouths.push(cue);
  }
  setEmotion(name: EmotionName, intensity = 1): void {
    this.emotions.push({ name, intensity });
  }
  setTurn(yaw: number): void {
    this.turns.push(yaw);
  }
  setGazeTarget(target: Vec3Like | null): void {
    this.gazes.push(target ? { x: target.x, y: target.y, z: target.z } : null);
  }
  playGesture(gestureName: string, baseClip: string): void {
    this.gestures.push({ gesture: gestureName, base: baseClip });
  }
  playClip(name: string): void {
    this.clips.push(name);
  }
  update(dt: number): void {
    this.updates.push(dt);
  }
}

const SCREEN_ANCHOR: ScreenAnchor = { screen: SCREEN };

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

// Drive a Performance through the FRAME-STEPPED export clock: t = i/fps, dt = 1/fps.
function driveExport(perf: Performance, fps: number, durationSec: number): { stage: FakeStage; avatar: FakeAvatar } {
  const stage = new FakeStage();
  const avatar = new FakeAvatar();
  const sd = new ScoreDrive(stage, avatar, SCREEN_ANCHOR);
  sd.load(perf);
  const total = Math.max(1, Math.ceil(durationSec * fps));
  const dt = 1 / fps;
  for (let i = 0; i < total; i++) sd.drive(i / fps, dt, SILENT);
  return { stage, avatar };
}

// Drive the SAME Performance through a simulated LIVE clock: an accumulating wall clock
// stepped by the same dt (a steady rAF). Same fps so the sampled commands line up 1:1.
function driveLive(perf: Performance, fps: number, durationSec: number): { stage: FakeStage; avatar: FakeAvatar } {
  const stage = new FakeStage();
  const avatar = new FakeAvatar();
  const sd = new ScoreDrive(stage, avatar, SCREEN_ANCHOR);
  sd.load(perf);
  const total = Math.max(1, Math.ceil(durationSec * fps));
  const dt = 1 / fps;
  let t = 0;
  for (let i = 0; i < total; i++) {
    sd.drive(t, dt, SILENT);
    t += dt;
  }
  return { stage, avatar };
}

describe('scoreDrive: command parity (live clock == export clock) at fixed t', () => {
  const perf = fixturePerformance();
  const fps = 30;
  const duration = perf.durationSec;

  it('issues the IDENTICAL camera trajectory on both clocks', () => {
    const exp = driveExport(perf, fps, duration);
    const live = driveLive(perf, fps, duration);
    expect(exp.stage.camLog.length).toBe(live.stage.camLog.length);
    expect(exp.stage.camLog.length).toBeGreaterThan(0);
    for (let i = 0; i < exp.stage.camLog.length; i++) {
      const a = exp.stage.camLog[i]!;
      const b = live.stage.camLog[i]!;
      for (let k = 0; k < 3; k++) {
        expect(a.pos[k]!).toBeCloseTo(b.pos[k]!, 9); // camera pos ≤ 1e-3 (here 1e-9)
        expect(a.target[k]!).toBeCloseTo(b.target[k]!, 9);
      }
      expect(a.fov).toBe(b.fov); // fov exact
    }
  });

  it('issues the IDENTICAL gesture / turn / emotion / screen commands on both clocks', () => {
    const exp = driveExport(perf, fps, duration);
    const live = driveLive(perf, fps, duration);
    expect(exp.avatar.gestures).toEqual(live.avatar.gestures);
    expect(exp.avatar.clips).toEqual(live.avatar.clips);
    expect(exp.avatar.turns).toEqual(live.avatar.turns);
    expect(exp.avatar.emotions).toEqual(live.avatar.emotions);
    expect(exp.stage.screenCuts).toEqual(live.stage.screenCuts);
  });

  it('fires each gesture / turn exactly once (one-shot latch holds forward)', () => {
    const { avatar } = driveExport(perf, fps, duration);
    // Fixture: 2 gestures (wave clip-overlay, point IK trigger), 1 turn.
    expect(avatar.turns.length).toBe(1);
    expect(avatar.gestures.length).toBe(2);
    expect(avatar.gestures[0]!.gesture).toBe('wave'); // library clip overlay
    expect(avatar.gestures[1]!.gesture).toBe('point'); // IK trigger clip name
  });

  it('drives the back-wall screen cut from the Performance screen channel', () => {
    const { stage } = driveExport(perf, fps, duration);
    // Window [2 s, 3 s]: setScreenCut fires only on TRANSITIONS — false (before, on frame 0),
    // true (cut on at 2 s), false (cut off at 3 s). This is the old updateScreenSource window
    // behavior preserved through the unified path, now sourced from Performance.screen.
    expect(stage.screenCuts.map((c) => c.active)).toEqual([false, true, false]);
    // seekScreen called every frame (montage stays in lockstep with the frame clock).
    expect(stage.seeks.length).toBeGreaterThan(0);
  });

  it('applies the emote intensity the old flat-array path dropped', () => {
    const { avatar } = driveExport(perf, fps, duration);
    // The beat-2 excited emote anchor (intensity 0.8) reaches setEmotion.
    expect(avatar.emotions.some((e) => e.name === 'excited' && Math.abs(e.intensity - 0.8) < 1e-9)).toBe(true);
  });
});

describe('scoreDrive: follow-damping trajectory parity (the term a boolean snap cannot capture)', () => {
  const fps = 30;
  const duration = 2;
  // A follow:true two-shot Performance whose followed subject (self.root) MOVES every frame:
  // we step the avatar's group.position between drive() calls so the two-shot re-frames and
  // the 0.45s ease lags it — the lag is what must match between live and export.
  function followPerf(): Performance {
    return buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], duration, []);
  }

  function driveWalking(useLiveClock: boolean, snapK: boolean): { pos: Vec3; target: Vec3 }[] {
    const stage = new FakeStage();
    const avatar = new FakeAvatar();
    const sd = new ScoreDrive(stage, avatar, SCREEN_ANCHOR);
    sd.load(followPerf());
    const total = Math.ceil(duration * fps);
    const dt = 1 / fps;
    let t = 0;
    for (let i = 0; i < total; i++) {
      // Walk the avatar root +x each frame so the followed subject moves.
      avatar.group.position = { x: i * 0.02, y: 0, z: 0 };
      if (snapK) {
        // Regression guard: force a hard snap (k=1) instead of the 0.45s ease, by calling
        // the fake stage's follow with snap=true — proves the test DETECTS the lag difference.
        stage.frameAnchorScreen(avatar.group.position, SCREEN, dt, true);
        stage.camLog.pop(); // remove the duplicate the manual call logged; keep drive's below
      }
      sd.drive(useLiveClock ? t : i / fps, dt, SILENT);
      t += dt;
    }
    return stage.camLog.map((c) => ({ pos: [...c.pos] as Vec3, target: [...c.target] as Vec3 }));
  }

  it('produces the IDENTICAL camera trajectory on live and export (same 1-exp(-dt/0.45) ease)', () => {
    const exp = driveWalking(false, false);
    const live = driveWalking(true, false);
    expect(exp.length).toBe(live.length);
    for (let i = 0; i < exp.length; i++) {
      for (let k = 0; k < 3; k++) {
        expect(exp[i]!.pos[k]!).toBeCloseTo(live[i]!.pos[k]!, 9);
        expect(exp[i]!.target[k]!).toBeCloseTo(live[i]!.target[k]!, 9);
      }
    }
  });

  it('DETECTS the snap-vs-smoothed difference (a hard k=1 snap diverges from the 0.45s ease)', () => {
    const smoothed = driveWalking(false, false);
    const snapped = driveWalking(false, true);
    // The trajectories must DIFFER materially — a boolean snap can't reproduce the ease lag.
    let maxDelta = 0;
    const n = Math.min(smoothed.length, snapped.length);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        maxDelta = Math.max(maxDelta, Math.abs((smoothed[i]!.pos[k] ?? 0) - (snapped[i]!.pos[k] ?? 0)));
      }
    }
    expect(maxDelta).toBeGreaterThan(0.1); // clearly distinguishable (metres)
  });
});

describe('scoreDrive: selectTalkClip determinism across a live-then-export sequence', () => {
  const fps = 30;
  // A multi-beat narration so several talk-base clips are picked in sequence.
  function talkPerf(): Performance {
    return buildNarrationPerformance(
      [
        { t: 0.0, gesture: 'wave', emotion: 'happy' },
        { t: 0.5, gesture: 'explain', emotion: 'serious' },
        { t: 1.0, gesture: 'nod', emotion: 'excited' },
        { t: 1.5, gesture: 'openPalms', emotion: 'warm' },
        { t: 2.0, gesture: 'explain', emotion: 'confident' },
      ],
      3,
      [],
    );
  }

  function clipSequence(useLiveClock: boolean): { gestures: { gesture: string; base: string }[]; clips: string[] } {
    const stage = new FakeStage();
    const avatar = new FakeAvatar();
    const sd = new ScoreDrive(stage, avatar, SCREEN_ANCHOR);
    sd.load(talkPerf());
    const total = Math.ceil(3 * fps);
    const dt = 1 / fps;
    let t = 0;
    for (let i = 0; i < total; i++) {
      sd.drive(useLiveClock ? t : i / fps, dt, SILENT);
      t += dt;
    }
    return { gestures: avatar.gestures, clips: avatar.clips };
  }

  it('chooses the SAME talk-base clip sequence on the live clock and the export clock', () => {
    const live = clipSequence(true);
    const exp = clipSequence(false);
    // The base clip chosen for each gesture overlay (and any bare talk clip) is identical:
    // baseEnergy-driven selectTalkClip + a caller-owned seq, NOT a module-global rotation.
    expect(live.gestures.map((g) => g.base)).toEqual(exp.gestures.map((g) => g.base));
    expect(live.clips).toEqual(exp.clips);
    // And the sequence visibly varies (not all the same clip → the rotation actually rotates).
    const bases = exp.gestures.map((g) => g.base);
    expect(new Set(bases).size).toBeGreaterThan(1);
  });

  it('live-speak reload() appends a gesture without replaying prior ones (same score.drive)', () => {
    // Mirrors performer.ts live free-text Speak: segments stream in over time; each appends
    // a gesture at the CURRENT clock and reload()s the Performance KEEPING the cursors — so a
    // new segment fires ONLY its own gesture, never replaying earlier ones.
    const stage = new FakeStage();
    const avatar = new FakeAvatar();
    const sd = new ScoreDrive(stage, avatar, SCREEN_ANCHOR);
    const dt = 1 / fps;
    const segs: { t: number; gesture: 'wave' | 'point' | 'nod'; emotion: EmotionName }[] = [];
    let t = 0;
    let firstSegment = true;
    // Stream three segments at 0.0 s, 0.4 s, 0.8 s, ticking between them.
    const arrivals: { at: number; gesture: 'wave' | 'point' | 'nod'; emotion: EmotionName }[] = [
      { at: 0.0, gesture: 'wave', emotion: 'happy' },
      { at: 0.4, gesture: 'nod', emotion: 'serious' },
      { at: 0.8, gesture: 'point', emotion: 'excited' },
    ];
    const total = Math.ceil(1.2 * fps);
    let ai = 0;
    for (let i = 0; i < total; i++) {
      // Deliver any segment whose arrival time has been reached this frame.
      while (ai < arrivals.length && (arrivals[ai]!.at <= t)) {
        const a = arrivals[ai]!;
        segs.push({ t, gesture: a.gesture, emotion: a.emotion });
        const perf = buildNarrationPerformance(segs, t + 1e6, []);
        if (firstSegment) {
          sd.load(perf, a.emotion);
          firstSegment = false;
        } else {
          sd.reload(perf, a.emotion);
        }
        ai++;
      }
      sd.drive(t, dt, SILENT);
      t += dt;
    }
    // Exactly three gestures fired, in arrival order — no replays.
    expect(avatar.gestures.map((g) => g.gesture)).toEqual(['wave', 'nod', 'point']);
    // The talk-base rotation advanced once per gesture (3 distinct picks possible, never reset).
    expect(avatar.gestures.length).toBe(3);
  });
});

describe('scoreDrive: per-frame allocation budget (rule C — no steady-state churn)', () => {
  it('drives 300 steady-state frames with a small per-frame heap delta', () => {
    const perf = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], 100, []);
    const stage = new FakeStage();
    const avatar = new FakeAvatar();
    const sd = new ScoreDrive(stage, avatar, SCREEN_ANCHOR);
    sd.load(perf);
    const dt = 1 / 30;
    // Warm up (let any one-shots fire + JIT settle), then measure steady state.
    for (let i = 0; i < 60; i++) sd.drive(i * dt, dt, SILENT);
    // Clear the spy logs so the recording arrays (test-only) don't dominate the measurement.
    stage.camLog.length = 0;
    stage.seeks.length = 0;
    avatar.mouths.length = 0;
    avatar.gazes.length = 0;
    avatar.updates.length = 0;
    const before = heapUsed();
    for (let i = 60; i < 360; i++) {
      sd.drive(i * dt, dt, SILENT);
      // Keep the test-only spy arrays bounded so they don't masquerade as drive allocation.
      if (stage.camLog.length > 1) stage.camLog.length = 0;
      if (stage.seeks.length > 1) stage.seeks.length = 0;
      if (avatar.mouths.length > 1) avatar.mouths.length = 0;
      if (avatar.gazes.length > 1) avatar.gazes.length = 0;
      if (avatar.updates.length > 1) avatar.updates.length = 0;
    }
    const after = heapUsed();
    const perFrame = (after - before) / 300;
    // Coarse GC-churn guard: ScoreDrive's per-frame path allocates only the small gaze
    // target object + the follow anchor read; well under a few KB/frame even before GC.
    expect(perFrame).toBeLessThan(4096);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// g3 regression suite — the behaviors the Phase-4c unification DROPPED, restored
// through the SAME score.drive path (live==export), pinned here so they can't regress.
// ─────────────────────────────────────────────────────────────────────────────
describe('scoreDrive g3: timeline motion cues restored through the unified path', () => {
  const fps = 30;

  it('a timeline turnScreen cue → IDENTICAL setTurn(0.6) on the live and export clocks', () => {
    // motion.turnScreen at t=1s, folded into the Performance turns channel by
    // buildNarrationPerformance (the cue the cutover dropped — the avatar never turned).
    const perf = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], 5, [], 'neutral', {
      motionCues: [{ t: 1.0, type: 'motion.turnScreen' }],
    });
    const exp = driveExport(perf, fps, 5);
    const live = driveLive(perf, fps, 5);
    // Fires exactly once, the SAME value, on both clocks — restoring catalog.applyMotion's 0.6.
    expect(exp.avatar.turns).toEqual([0.6]);
    expect(live.avatar.turns).toEqual([0.6]);
  });

  it('motion.faceFront → setTurn(0); motion.point → setTurn(0.6*0.7) + a point gesture', () => {
    const perf = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], 5, [], 'neutral', {
      motionCues: [
        { t: 0.5, type: 'motion.point' },
        { t: 2.0, type: 'motion.faceFront' },
      ],
    });
    const { avatar } = driveExport(perf, fps, 5);
    // point yaw then faceFront yaw, ascending — matching motionCueTurn (the shared vocabulary).
    expect(avatar.turns).toEqual([0.6 * 0.7, 0]);
    // point also plays the point IK overlay gesture (not just a turn).
    expect(avatar.gestures.some((g) => g.gesture === 'point')).toBe(true);
  });
});

describe('scoreDrive g3: authored static (follow:false) camera keyframe is applied, not dropped', () => {
  const fps = 30;

  it('lands the authored absolute pose via setCameraPose (no ease-in from a stale pose)', () => {
    const perf = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], 2, [], 'neutral', {
      cameraCues: [{ tSec: 0.5, pos: [1, 2, 3], target: [4, 5, 6], fov: 33 }],
      followCamera: false, // isolate the authored static keyframe (no two-shot follow)
    });
    const { stage } = driveExport(perf, fps, 2);
    // Before t=0.5 there is no active keyframe → no camera command at all (not dropped silently
    // onto a wrong pose); from t=0.5 onward the EXACT authored pose is applied every frame.
    expect(stage.poses.length).toBeGreaterThan(0);
    const last = stage.poses[stage.poses.length - 1]!;
    expect(last.pos).toEqual([1, 2, 3]);
    expect(last.target).toEqual([4, 5, 6]);
    expect(last.fov).toBe(33);
    // No follow keyframe emitted → frameAnchorScreen never ran.
    expect(stage.snaps.length).toBe(0);
  });

  it('an authored cue at the same tSec as the follow keyframe WINS (follow covers only the gap)', () => {
    const perf = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], 2, [], 'neutral', {
      cameraCues: [{ tSec: 0, pos: [7, 8, 9], target: [0, 0, 0], fov: 40 }],
      // followCamera default true → follow@0 + static@0; the static (later index) wins at t=0.
    });
    const { stage } = driveExport(perf, fps, 2);
    expect(stage.poses[0]!.pos).toEqual([7, 8, 9]);
  });
});

describe('scoreDrive g3: export opens snapped to the frame-0 two-shot (restored snap-override)', () => {
  const fps = 30;

  it('frame 0 snaps (snap=true) then every later frame uses the smoothed follow (snap=false)', () => {
    const perf = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], 2, []);
    const exp = driveExport(perf, fps, 2);
    const live = driveLive(perf, fps, 2);
    // Frame 0 is the EXACT two-shot on both clocks (no ~1s ease-in from a stale orbit pose);
    // frames ≥1 share the unified 1-exp(-dt/0.45) ease.
    expect(exp.stage.snaps[0]).toBe(true);
    expect(live.stage.snaps[0]).toBe(true);
    expect(exp.stage.snaps.slice(1).every((s) => s === false)).toBe(true);
    expect(exp.stage.snaps.length).toBeGreaterThan(2);
    // Frame 0 already sits at the composed two-shot for the anchor at the origin.
    const want = composeShot([{ pos: [0, 0, 0] }, { pos: [SCREEN.x, SCREEN.y, SCREEN.z] }], { follow: true });
    for (let k = 0; k < 3; k++) expect(exp.stage.camLog[0]!.pos[k]!).toBeCloseTo(want.pos[k]!, 9);
  });
});

describe('scoreDrive g3: overlapping screen-cut windows keep the outer cut open (union semantics)', () => {
  const fps = 30;

  it('a nested window closing does NOT end a still-open outer window', () => {
    // W1=[0,10] fully contains W2=[5,7]. The old updateScreenSource used a .some() union, so
    // t=8 stayed cut-to-screen; the latest-mark-wins reducer would (without merging) cut back
    // to the scene at 7. buildNarrationPerformance now MERGES the windows → one [0,10] cut.
    const perf = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], 12, [
      { start: 0, duration: 10 },
      { start: 5, duration: 2 },
    ]);
    const { stage } = driveExport(perf, fps, 12);
    // Transitions only: off (frame 0, before t=0… actually starts active at 0), then the single
    // merged window: cut on at 0, cut off at 10. No spurious off at 7.
    expect(stage.screenCuts.map((c) => c.active)).toEqual([true, false]);
  });
});

describe('scoreDrive g3: alloc-free per-frame even with an authored look (rule C)', () => {
  it('drives 300 steady-state frames with a non-empty looks array at a small heap delta', () => {
    // A self.face look makes advanceLook → resolveTarget run EVERY frame; it must reuse the
    // gaze scratch (not allocate a fresh {x,y,z} literal per frame).
    const base = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], 100, []);
    const perf: Performance = { ...base, looks: [{ tSec: 0, target: { bind: 'face' } }] };
    const stage = new FakeStage();
    const avatar = new FakeAvatar();
    const sd = new ScoreDrive(stage, avatar, SCREEN_ANCHOR);
    sd.load(perf);
    const dt = 1 / 30;
    for (let i = 0; i < 60; i++) sd.drive(i * dt, dt, SILENT);
    stage.camLog.length = 0;
    stage.snaps.length = 0;
    stage.seeks.length = 0;
    avatar.mouths.length = 0;
    avatar.gazes.length = 0;
    avatar.updates.length = 0;
    const before = heapUsed();
    for (let i = 60; i < 360; i++) {
      sd.drive(i * dt, dt, SILENT);
      if (stage.camLog.length > 1) stage.camLog.length = 0;
      if (stage.snaps.length > 1) stage.snaps.length = 0;
      if (stage.seeks.length > 1) stage.seeks.length = 0;
      if (avatar.mouths.length > 1) avatar.mouths.length = 0;
      if (avatar.gazes.length > 1) avatar.gazes.length = 0;
      if (avatar.updates.length > 1) avatar.updates.length = 0;
    }
    const after = heapUsed();
    expect((after - before) / 300).toBeLessThan(4096);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wall-slide deck — the 'graphics' channel, driven identically on both clocks.
// ─────────────────────────────────────────────────────────────────────────────
describe('scoreDrive: wall-slide deck parity (live clock == export clock)', () => {
  const fps = 30;
  const duration = 4;
  const SLIDE_A: SlideContent = { kicker: 'LIVE', headline: 'Top story', bullets: ['One', 'Two'], ticker: 'TOP STORY  ·  LIVE' };
  const SLIDE_B: SlideContent = { kicker: 'LIVE', headline: 'Markets', bullets: [], ticker: 'MARKETS  ·  LIVE' };

  // Drive a Performance recording every setSlide call through the injected slide sink (the 4th
  // ScoreDrive dep — the studio's setSlide in production, a spy here; no DOM / canvas needed).
  function driveSlides(useLiveClock: boolean, perf: Performance): SlideContent[] {
    const stage = new FakeStage();
    const avatar = new FakeAvatar();
    const got: SlideContent[] = [];
    const sd = new ScoreDrive(stage, avatar, SCREEN_ANCHOR, (s) => got.push(s));
    sd.load(perf);
    const total = Math.max(1, Math.ceil(duration * fps));
    const dt = 1 / fps;
    let t = 0;
    for (let i = 0; i < total; i++) {
      sd.drive(useLiveClock ? t : i / fps, dt, SILENT);
      t += dt;
    }
    return got;
  }

  it('a graphics cue at tSec → the SAME setSlide call sequence on both clocks (live == export)', () => {
    const perf = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], duration, [], 'neutral', {
      slideCues: [{ tSec: 0, slide: SLIDE_A }, { tSec: 2, slide: SLIDE_B }],
    });
    const exp = driveSlides(false, perf);
    const live = driveSlides(true, perf);
    expect(exp).toEqual(live); // identical slide sequence on the export + live clocks
    expect(exp.map((s) => s.headline)).toEqual(['Top story', 'Markets']); // swap at the section boundary
    expect(exp[0]!.image).toBeUndefined(); // NO image → the studio renders the gradient fallback
  });

  it('seeds t=0 so the first slide shows from frame 0 even when the earliest cue is later', () => {
    const perf = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], duration, [], 'neutral', {
      slideCues: [{ tSec: 1.5, slide: SLIDE_B }],
    });
    expect(perf.slides[0]!.tSec).toBe(0); // buildNarrationPerformance pulled a copy back to 0
    expect(driveSlides(false, perf)[0]!.headline).toBe('Markets'); // shown at frame 0
  });

  it('fires each slide exactly once over the take (forward cursor latch, no per-frame churn)', () => {
    const perf = buildNarrationPerformance([{ t: 0, gesture: 'explain', emotion: 'neutral' }], duration, [], 'neutral', {
      slideCues: [{ tSec: 0, slide: SLIDE_A }, { tSec: 2, slide: SLIDE_B }],
    });
    expect(driveSlides(false, perf).length).toBe(2); // two slide changes total, not once-per-frame
  });
});

// Node heap sampling (vitest runs in node) — coarse, GC-tolerant.
function heapUsed(): number {
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === 'function') g.gc();
  return typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage().heapUsed : 0;
}
