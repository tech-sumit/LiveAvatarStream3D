// compileScore — the deterministic spatial compiler.
//
// Orchestrates @las/performer-core (composeShot / planPath / turnToward / resolveGesture)
// to lower an authored Score + Stage into a low-level Performance: absolute-timed camera
// keyframes (incl. relative `move` keyframes and follow keyframes with late-bound subjects),
// motion paths with arrival facing, resolved turns, gesture params, looks, emotes, a back-wall
// screen channel, an audio channel, and a 2D-safe per-beat projection.
//
// Pure & deterministic — like compileNewsReport but spatial. No Date / Math.random / module
// counters. `self.*` refs are emitted as a late-bound BodyRef marker (NEVER baked) so score.drive
// re-resolves them per-frame against the live GLB.

import { CAMERA_SHOTS, composeShot, moveCamera, planPath, sampleShot, turnToward } from '@las/performer-core';
import type { CameraShotId, Vec3 as CoreVec3, Pose as CorePose, Subject } from '@las/performer-core';

import type { Stage, Mark, Target, SavedShot, Vec3 } from './stage.js';
import type {
  Score,
  ScoreBeat,
  Cue,
  CameraDirective,
  ShotSize,
  GestureKind,
  EmotionPreset,
  AudioTimings,
} from './score.js';
// BeatTiming's inferred element type (score.ts exports the zod value, not the type).
type BeatTiming = AudioTimings['beats'][number];
import { resolveGesture as resolveGestureCue } from '@las/performer-core';
import type { Performance, SlideContent } from './performance.js';
import type { Posture } from './dsl.js';
import type { AudioCue, NewsReportDoc, DocDefaults } from './newsreport.js';
import { estDuration, round1, sectionSlide } from './newsreportCompile.js';
import { EMOTION_ENERGY } from './presets.js';

// ── Resolved-ref shapes (mirror performance.ts ResolvedTargetRef without importing the zod value) ──
type ResolvedTargetRef = { pos: Vec3 } | { bind: 'face' | 'chest' | 'root' } | { node: string };

// ── Output keyframe/path shapes (mirror performance.ts; the function returns a parsed-shape object) ──
type CameraKeyframe = {
  tSec: number;
  pos: Vec3;
  target: Vec3;
  fov: number;
  follow: boolean;
  followSubjects?: ResolvedTargetRef[];
  ease?: 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out';
  move?: 'dolly' | 'orbit' | 'pan' | 'truck' | 'pedestal';
  moveAmount?: number;
  preset?: string; // catalog shot-preset id — the runtime resolves it against the live avatar
  roll?: number; // dutch tilt (deg) from a preset snapshot
};
type MotionPath = {
  startSec: number;
  endSec: number;
  from: Vec3;
  to: Vec3;
  gait: 'walk' | 'stride';
  speed: number;
  arriveFacing?: number;
};
type ResolvedTurn = { tSec: number; yaw: number };
type ResolvedGesture = {
  tSec: number;
  kind: GestureKind;
  drive: { kind: 'clip' | 'ik' | 'none'; clip?: string; ik?: 'aim' | 'count'; baseEnergy?: 'low' | 'med' | 'high' };
  target?: ResolvedTargetRef;
  side?: 'left' | 'right';
  count?: number;
  hold?: number;
};
type ResolvedLook = { tSec: number; target: ResolvedTargetRef };
type ResolvedEmote = { tSec: number; emotion: EmotionPreset; intensity: number };
type ScreenCut = { tSec: number; source: string };
type BeatProjection = {
  startSec: number;
  endSec: number;
  text: string;
  emotion: EmotionPreset;
  intensity: number;
  gesture: GestureKind;
  posture: Posture;
};

// ── Defaults / data ─────────────────────────────────────────────────────────
const DEFAULT_BODY: { face: Vec3; chest: Vec3; root: Vec3 } = {
  face: [0, 1.6, 0],
  chest: [0, 1.2, 0],
  root: [0, 0, 0],
};
const DEFAULT_EMOTION: EmotionPreset = 'neutral';
const DEFAULT_GESTURE: GestureKind = 'none';
const DEFAULT_POSTURE: Posture = 'neutral';

// Emotion → resting posture projection (2D-safe; §10). Energetic emotions lean in.
const EMOTION_TO_POSTURE: Record<EmotionPreset, Posture> = {
  neutral: 'neutral',
  warm: 'relaxed',
  happy: 'leaning_in',
  excited: 'leaning_in',
  surprised: 'upright',
  serious: 'upright',
  concerned: 'leaning_in',
  sad: 'relaxed',
  confident: 'upright',
  thoughtful: 'turned_slightly',
};

// ── Guarded indexing helpers (Cross-cutting rule B: noUncheckedIndexedAccess) ──
function atOr<T>(arr: readonly T[], i: number, fallback: T): T {
  const v = arr[i];
  return v === undefined ? fallback : v;
}

let warnedWordAnchor = false;
let warnedNodeCompilePos = false;
/**
 * A node-bound target has no static world position at compile time — warn once per compile so
 * the late-bind fallback (body root for framing/aim math) is visible rather than silent.
 */
function warnNodeCompilePos(ref: string, node: string): void {
  if (warnedNodeCompilePos) return;
  console.warn(
    `compileScore: node-bound target '${ref}' (node '${node}') has no compile-time position; ` +
      `late-binding at runtime, using body root for compile-time framing/aim`,
  );
  warnedNodeCompilePos = true;
}
/**
 * Absolute start time (sec) of a beat's Nth word. Under noUncheckedIndexedAccess
 * `beat.words[idx]` is `WordTiming | undefined`; an out-of-range anchor is a DEFINED
 * error path — clamp to the last word's start (or beat.startSec if no words) and warn
 * once. Never returns NaN, never throws.
 */
function wordStartSec(beat: BeatTiming, idx: number): number {
  const words = beat.words;
  if (words.length === 0) return beat.startSec;
  if (idx < 0 || idx >= words.length) {
    if (!warnedWordAnchor) {
      console.warn(`compileScore: WordAnchor index ${idx} out of range (beat has ${words.length} words); clamping`);
      warnedWordAnchor = true;
    }
    const last = words[words.length - 1];
    return last ? last.startSec : beat.startSec;
  }
  const w = words[idx];
  return w ? w.startSec : beat.startSec;
}

// ── Stage lookup ─────────────────────────────────────────────────────────────
type StageIndex = {
  marks: Map<string, Mark>;
  targets: Map<string, Target>;
  shots: Map<string, SavedShot>;
};
function indexStage(stage: Stage): StageIndex {
  const marks = new Map<string, Mark>();
  for (const m of stage.marks) marks.set(m.id, m);
  const targets = new Map<string, Target>();
  for (const t of stage.targets) targets.set(t.id, t);
  const shots = new Map<string, SavedShot>();
  for (const s of stage.savedShots) shots.set(s.id, s);
  return { marks, targets, shots };
}

const SELF_BINDS: Record<string, 'face' | 'chest' | 'root'> = {
  'self.face': 'face',
  'self.chest': 'chest',
  'self.root': 'root',
};

// ── compileScore ─────────────────────────────────────────────────────────────
export function compileScore(
  stage: Stage,
  score: Score,
  timings: AudioTimings,
  body?: { face?: Vec3; chest?: Vec3; root?: Vec3 },
  extra?: { audio?: AudioCue[]; screen?: ScreenCut[]; slides?: { tSec: number; slide: SlideContent }[] },
): Performance {
  warnedWordAnchor = false;
  warnedNodeCompilePos = false;
  const idx = indexStage(stage);
  const bodyPos = {
    face: body?.face ?? DEFAULT_BODY.face,
    chest: body?.chest ?? DEFAULT_BODY.chest,
    root: body?.root ?? DEFAULT_BODY.root,
  };
  const defaults = score.defaults ?? {};

  // resolveRef → late-bound BodyRef for self.*, late-bound NodeRef for node-bound targets,
  // static {pos} for marks/pos-targets/shots.
  function resolveRef(ref: string): ResolvedTargetRef {
    const bind = SELF_BINDS[ref];
    if (bind) return { bind };
    const mark = idx.marks.get(ref);
    if (mark) return { pos: mark.pos };
    const target = idx.targets.get(ref);
    if (target) {
      if (target.pos) return { pos: target.pos };
      // Node-bound target (pos undefined, node set): carry the node name late-bound — like
      // self.*, score.drive re-resolves it per-frame against the live GLB. NEVER bake [0,0,0].
      if (target.node) return { node: target.node };
      // A target with neither pos nor node is malformed — surface it loudly, don't silently root.
      throw new Error(`compileScore: Target '${ref}' has neither pos nor node`);
    }
    const shot = idx.shots.get(ref);
    if (shot) return { pos: shot.pose.pos };
    // Unknown ref → fall back to body root (defined, deterministic; never throws).
    return { bind: 'root' };
  }

  // Static world position for compile-time math (composeShot subjects, turnToward).
  // self.* uses the documented body fallback (the ONLY compile-time use of `body`).
  // Node-bound targets have no static compile-time world position; they late-bind at runtime,
  // so compile-time math (framing/aim) warns once and uses the body root rather than a silent,
  // un-signalled [0,0,0]. The resolveRef path still carries the {node} for the runtime to honor.
  function refPos(ref: string): Vec3 {
    const bind = SELF_BINDS[ref];
    if (bind) return bodyPos[bind];
    const r = resolveRef(ref);
    if ('pos' in r) return r.pos;
    if ('bind' in r) return bodyPos[r.bind];
    // node-bound: no compile-time position.
    warnNodeCompilePos(ref, r.node);
    return bodyPos.root;
  }

  // Mark facing (number yaw | TargetRef) → yaw radians at the destination.
  function facingYaw(markPos: Vec3, facing: number | string | undefined): number | undefined {
    if (facing === undefined) return undefined;
    if (typeof facing === 'number') return facing;
    return turnToward(markPos as CoreVec3, refPos(facing) as CoreVec3);
  }

  const cameraKfs: CameraKeyframe[] = [];
  const motion: MotionPath[] = [];
  const turns: ResolvedTurn[] = [];
  const gestures: ResolvedGesture[] = [];
  const looks: ResolvedLook[] = [];
  const emotes: ResolvedEmote[] = [];
  // screen / audio channels: stage-/score-level cuts plus any carried from the NewsReport bridge.
  const screen: ScreenCut[] = extra?.screen ? [...extra.screen] : [];
  const audio: AudioCue[] = extra?.audio ? [...extra.audio] : [];
  const projection: BeatProjection[] = [];

  // The avatar's current world position (XZ), updated by `move` cues — `turn.to:Ref` faces from here.
  let avatarPos: Vec3 = [bodyPos.root[0], bodyPos.root[1], bodyPos.root[2]];
  let durationSec = 0;

  // Sticky default camera (carry-forward, like newsreportCompile): the default ONLY seeds the
  // opening, before any authored camera. Once ANY camera keyframe has been emitted (authored or
  // default), camera-less beats hold the last shot — they don't snap back to the default. The
  // default is fixed for the run, so it stays const.
  const stickyCamera: CameraDirective | undefined = defaults.camera;
  let emittedAnyCamera = false;

  for (let bi = 0; bi < score.beats.length; bi++) {
    const beat = score.beats[bi];
    if (!beat) continue;
    const bt = atOr(timings.beats, bi, { startSec: durationSec, endSec: durationSec, words: [] });
    const beatStart = bt.startSec;
    const beatEnd = bt.endSec;

    // Defaults cascade: beat emotion ??= defaults.emotion.
    const beatEmotion: EmotionPreset = beat.emotion ?? defaults.emotion ?? DEFAULT_EMOTION;
    let beatGesture: GestureKind = DEFAULT_GESTURE;
    let beatIntensity = 1;

    function cueTime(cue: Cue): number {
      const at = cue.at;
      if (!at) return beatStart;
      return wordStartSec(bt, at.word);
    }

    // If the beat authors no camera cue, inherit the sticky/default camera once it changes.
    const hasCameraCue = beat.cues.some((c) => 'camera' in c);

    for (const cue of beat.cues) {
      const tSec = cueTime(cue);

      if ('move' in cue) {
        const toRef = cue.move.to;
        const toMark = idx.marks.get(toRef);
        const to = refPos(toRef);
        const gait = cue.move.gait ?? defaults.gait ?? 'walk';
        const arriveFacing = toMark ? facingYaw(toMark.pos, toMark.facing) : undefined;
        const plan = planPath(avatarPos as CoreVec3, to as CoreVec3, {
          gait,
          ...(cue.move.speed !== undefined ? { speed: cue.move.speed } : {}),
          ...(arriveFacing !== undefined ? { arriveFacing } : {}),
        });
        const mp: MotionPath = {
          startSec: tSec,
          endSec: beatEnd,
          from: [avatarPos[0], avatarPos[1], avatarPos[2]],
          to: [to[0], to[1], to[2]],
          gait: plan.gait,
          speed: plan.speed,
        };
        if (plan.arriveFacing !== undefined) mp.arriveFacing = plan.arriveFacing;
        motion.push(mp);
        avatarPos = [to[0], to[1], to[2]];
        continue;
      }

      if ('turn' in cue) {
        const to = cue.turn.to;
        const yaw = typeof to === 'number' ? to : turnToward(avatarPos as CoreVec3, refPos(to) as CoreVec3);
        turns.push({ tSec, yaw });
        continue;
      }

      if ('gesture' in cue) {
        const g = cue.gesture;
        beatGesture = g.kind;
        const drive = resolveGestureCue(g.kind, {
          ...(g.target !== undefined ? { target: refPos(g.target) as CoreVec3 } : {}),
          ...(g.hand !== undefined ? { hand: g.hand } : {}),
          ...(g.count !== undefined ? { count: g.count } : {}),
          ...(g.hold !== undefined ? { hold: g.hold } : {}),
          ...(g.amount !== undefined ? { amount: g.amount } : {}),
        });
        // Energy: an explicit per-gesture `amount` hint wins (resolveGestureCue already mapped it
        // to drive.baseEnergy via energyFromAmount); else fall back to the beat emotion bucket.
        // Both are deterministic (no global counter).
        const baseEnergy = g.amount !== undefined ? drive.baseEnergy : EMOTION_ENERGY[beatEmotion];
        const rg: ResolvedGesture = {
          tSec,
          kind: g.kind,
          drive: {
            kind: drive.kind,
            ...(drive.clip !== undefined ? { clip: drive.clip } : {}),
            ...(drive.ik !== undefined ? { ik: drive.ik } : {}),
            baseEnergy,
          },
        };
        if (g.target !== undefined) rg.target = resolveRef(g.target);
        if (g.hand !== undefined && g.hand !== 'auto') rg.side = g.hand;
        if (g.count !== undefined) rg.count = g.count;
        if (g.hold !== undefined) rg.hold = g.hold;
        gestures.push(rg);
        continue;
      }

      if ('look' in cue) {
        looks.push({ tSec, target: resolveRef(cue.look.at) });
        continue;
      }

      if ('emote' in cue) {
        const intensity = cue.emote.intensity ?? 1;
        emotes.push({ tSec, emotion: cue.emote.emotion, intensity });
        // Seed the beat projection emotion/intensity from the emote anchor.
        beatIntensity = intensity;
        continue;
      }

      if ('camera' in cue) {
        const kf = compileCamera(cue.camera, tSec, resolveRef, refPos, idx);
        if (kf) {
          cameraKfs.push(kf);
          // An authored camera establishes the shot — the default must never seed/snap after it.
          emittedAnyCamera = true;
        } else {
          // Emitted NOTHING (e.g. an unknown SavedShot id): surface it loudly and do NOT latch
          // emittedAnyCamera — otherwise the sticky default camera is suppressed by a cue that
          // produced no keyframe at all, and the opening shot silently never gets seeded.
          console.warn(
            `[compileScore] camera cue at ${tSec}s resolved to no keyframe ` +
              `(${'shot' in cue.camera ? `unknown shot id '${cue.camera.shot}'` : 'unresolvable directive'}) — ignored.`,
          );
        }
        continue;
      }
    }

    // Sticky default camera: seed defaults.camera only on the opening beats, before any authored
    // camera. Once a shot exists, a camera-less beat holds it (no keyframe) instead of reverting.
    if (!hasCameraCue && stickyCamera && !emittedAnyCamera) {
      const kf = compileCamera(stickyCamera, beatStart, resolveRef, refPos, idx);
      if (kf) cameraKfs.push(kf);
      emittedAnyCamera = true;
    }

    // 2D-safe projection (§10): emotion (sticky), intensity (from emote), gesture, posture.
    projection.push({
      startSec: beatStart,
      endSec: beatEnd,
      text: beat.text,
      emotion: beatEmotion,
      intensity: beatIntensity,
      gesture: beatGesture,
      posture: EMOTION_TO_POSTURE[beatEmotion] ?? DEFAULT_POSTURE,
    });

    durationSec = Math.max(durationSec, beatEnd);
  }

  // Sort by time BEFORE resolving moves: word-anchored cues can emit out of array order, and
  // (a) a move must resolve against its TIME-preceding keyframe, not an array neighbor, and
  // (b) the runtime's advanceCamera scans for the latest keyframe ≤ t assuming ascending tSec.
  cameraKfs.sort((a, b) => a.tSec - b.tSec); // Array.sort is stable — equal-tSec cues keep authored order
  return {
    stageId: stage.id,
    durationSec,
    beats: projection,
    camera: resolveMoveKeyframes(cameraKfs),
    motion,
    turns,
    gestures,
    looks,
    emotes,
    screen,
    // A pure Score authors no wall slides yet; a lowered NewsReportDoc threads its section
    // slides here via `extra` (newsReportChrome), on the SAME clock as the beats — so the
    // wall deck advances during Score-path takes/exports (advanceSlide always worked; only
    // this channel was hardcoded empty).
    slides: [...(extra?.slides ?? [])].sort((a, b) => a.tSec - b.tSec),
    audio,
  };
}

/**
 * Resolve relative `move` keyframes to absolute poses at compile time. compileCamera emits a
 * `{pos:[0,0,0], fov:0, move, moveAmount}` sentinel for a `camera:{move}` directive, but NO
 * runtime interprets it — scoreDrive.advanceCamera has no move branch, so the sentinel was
 * applied verbatim and teleported the camera to the origin. Here each move keyframe is applied
 * (performer-core `moveCamera`) against the nearest PRECEDING keyframe's pose. Every non-move
 * keyframe compileScore emits carries a real compile-time pose (frame/pose/shot are composed
 * absolutes; a follow keyframe holds its compile-time snapshot), so the base is that snapshot —
 * resolved moves chain, so consecutive dollies compose. A move with NO predecessor at all
 * cannot be resolved and is DROPPED with a loud warning (repo convention: failures surface,
 * never silently corrupt — the sentinel used to corrupt silently).
 */
function resolveMoveKeyframes(kfs: CameraKeyframe[]): CameraKeyframe[] {
  const out: CameraKeyframe[] = [];
  for (const kf of kfs) {
    if (kf.move === undefined) {
      out.push(kf);
      continue;
    }
    const base = out[out.length - 1];
    if (!base) {
      console.warn(
        `[compileScore] camera move '${kf.move}' at ${kf.tSec}s has no preceding camera ` +
          `keyframe to resolve against — dropping it (author a frame/pose/shot first).`,
      );
      continue;
    }
    const basePose: CorePose = { pos: [...base.pos], target: [...base.target], fov: base.fov };
    const moved = moveCamera(basePose, kf.move, kf.moveAmount ?? 0);
    const resolved: CameraKeyframe = {
      tSec: kf.tSec,
      pos: [moved.pos[0], moved.pos[1], moved.pos[2]],
      target: [moved.target[0], moved.target[1], moved.target[2]],
      fov: moved.fov || base.fov,
      follow: false,
    };
    if (kf.ease !== undefined) resolved.ease = kf.ease;
    out.push(resolved);
  }
  return out;
}

// ── Camera directive lowering ────────────────────────────────────────────────
function compileCamera(
  dir: CameraDirective,
  tSec: number,
  resolveRef: (ref: string) => ResolvedTargetRef,
  refPos: (ref: string) => Vec3,
  idx: StageIndex,
): CameraKeyframe | undefined {
  if ('shot' in dir) {
    const shot = idx.shots.get(dir.shot);
    if (!shot) return undefined;
    return {
      tSec,
      pos: shot.pose.pos,
      target: shot.pose.target,
      fov: shot.pose.fov,
      follow: false,
    };
  }
  if ('pose' in dir) {
    // Authored absolute pose: the framing is DATA carried verbatim from the score — no preset
    // math. Held every frame as a static (follow:false) keyframe (live == export).
    return {
      tSec,
      pos: [dir.pose.pos[0], dir.pose.pos[1], dir.pose.pos[2]],
      target: [dir.pose.target[0], dir.pose.target[1], dir.pose.target[2]],
      fov: dir.pose.fov,
      follow: false,
    };
  }
  if ('preset' in dir) {
    // Catalog shot-preset: carried by NAME on the keyframe — the runtime (scoreDrive) resolves
    // it against the LIVE avatar per frame (head-height-correct, push-in progression from
    // t − tSec, dutch roll). pos/target/fov hold a compile-time snapshot against the default
    // face position so preset-less consumers of the Performance still frame sanely.
    const shot = CAMERA_SHOTS[dir.preset];
    if (!shot) {
      console.warn(`[compileScore] unknown camera preset '${dir.preset}' — ignored.`);
      return undefined;
    }
    // Snapshot with the preset's OWN subject geometry (anchor / screen / both) so the baked
    // pose is at least the right composition — it seeds resolveMoveKeyframes for a following
    // {move} directive and any preset-less consumer. 0.42 = nominal head height (the repo's
    // reference avatar); the runtime re-resolves against the live avatar every frame anyway.
    const anchorSub: Subject = { pos: refPos('self.face') as CoreVec3, size: 0.42 };
    const screenTarget = idx.targets.get('screen');
    const screenSub: Subject | null = screenTarget?.pos ? { pos: screenTarget.pos as CoreVec3, size: 1 } : null;
    const subjects: Subject[] =
      shot.subject === 'both' && screenSub
        ? [anchorSub, screenSub]
        : shot.subject === 'screen' && screenSub
          ? [screenSub]
          : [anchorSub]; // no 'screen' target on this stage → anchor framing is the sane fallback
    const pose = sampleShot(shot, subjects, 0);
    const kf: CameraKeyframe = {
      tSec,
      pos: [pose.pos[0], pose.pos[1], pose.pos[2]],
      target: [pose.target[0], pose.target[1], pose.target[2]],
      fov: pose.fov,
      follow: false,
      preset: dir.preset,
    };
    if (pose.roll) kf.roll = pose.roll; // dutch tilt survives onto the keyframe snapshot
    return kf;
  }
  if ('move' in dir) {
    // Relative move: no absolute pose; the runtime applies moveCamera against the prior keyframe.
    const kf: CameraKeyframe = {
      tSec,
      pos: [0, 0, 0],
      target: [0, 0, 0],
      fov: 0,
      follow: false,
      move: dir.move,
      moveAmount: dir.amount,
    };
    if (dir.ease !== undefined) kf.ease = dir.ease;
    return kf;
  }
  // frame directive.
  const frame = dir.frame;
  const subjects: Subject[] = frame.subjects.map((ref) => {
    const p = refPos(ref);
    return { pos: p as CoreVec3 };
  });
  const composition: { size?: ShotSize; height?: number; balance?: number; lens?: number } = {};
  if (frame.size !== undefined) composition.size = frame.size;
  if (frame.height !== undefined) composition.height = frame.height;
  if (frame.balance !== undefined) composition.balance = frame.balance;
  if (frame.lens !== undefined) composition.lens = frame.lens;
  // composeShot's SIZE_TABLE is the single source of truth for size→framing.
  const pose = composeShot(subjects, composition);
  const follow = dir.follow ?? false;
  const kf: CameraKeyframe = {
    tSec,
    pos: [pose.pos[0], pose.pos[1], pose.pos[2]],
    target: [pose.target[0], pose.target[1], pose.target[2]],
    fov: pose.fov,
    follow,
  };
  if (follow) kf.followSubjects = frame.subjects.map((ref) => resolveRef(ref));
  return kf;
}

// ── NewsReport → Score back-compat bridge ─────────────────────────────────────
//
// Lowers an existing NewsReportDoc into a Score that compiles cleanly through compileScore,
// preserving the same camera buckets, the same gesture montage sequence, the same per-beat
// emotion, and (via newsReportAudio) the same music beds / SFX. Reuses compileNewsReport's
// constants as the lowering source. The NewsReport Emotion enum is a superset-equal of
// EmotionPreset; the Gesture enum is snake_case and is translated to camelCase GestureKind here.

const NEWS_CLOSE_SHOTS = new Set(['close_up', 'extreme_close_up', 'medium_close']);
const NEWS_WIDE_SHOTS = new Set(['wide', 'full']);

// snake_case dsl.Gesture → camelCase GestureKind (the casing seam, bridge direction).
const NEWS_GESTURE_TO_KIND: Record<string, GestureKind> = {
  none: 'none',
  wave: 'wave',
  point: 'point',
  open_palms: 'openPalms',
  count: 'count',
  thumbs_up: 'thumbsUp',
  nod: 'nod',
  shrug: 'shrug',
  hand_to_chest: 'handToChest',
  explain: 'explain',
};

function newsShotSize(shot: string | undefined): ShotSize {
  if (shot && NEWS_CLOSE_SHOTS.has(shot)) return 'cu';
  if (shot && NEWS_WIDE_SHOTS.has(shot)) return 'wide';
  return 'medium';
}

export function compileNewsReportToScore(doc: NewsReportDoc): Score {
  const d: Partial<DocDefaults> = doc.defaults ?? {};
  const defEmotion = (d.emotion ?? 'neutral') as EmotionPreset;
  const defShot = newsShotSize(d.camera?.shot);
  // An authored studio camera pose (DATA) locks the framing for the whole newscast — emit it
  // once at the top and suppress the shot-bucket frame cues (the preset path) entirely.
  const cameraPose = d.cameraPose;
  let poseEmitted = false;

  const beats: ScoreBeat[] = [];
  let prevSize: ShotSize | null = null;
  let prevGesture: GestureKind | null = null;
  let curSize: ShotSize = defShot;
  // Catalog shot-presets carry by NAME (replace + carry-forward, like the shot bucket). A
  // preset outranks the descriptive shot field on the same cue — mirroring the legacy path's
  // cameraTypeFor — and no spurious `medium` frame cue is emitted for a preset-only cue.
  let curPreset: CameraShotId | null = d.camera?.preset ?? null;
  let prevPreset: CameraShotId | null = null;

  for (const section of doc.rundown) {
    if (section.cameraDefault) {
      curSize = newsShotSize(section.cameraDefault.shot);
      curPreset = section.cameraDefault.preset ?? null;
    }
    let curEmotion: EmotionPreset = defEmotion; // re-seed each section
    let sectionStart = true;

    for (const beat of section.beats) {
      if (beat.emotion) curEmotion = beat.emotion as EmotionPreset;
      if (beat.camera) {
        curSize = newsShotSize(beat.camera.shot);
        curPreset = beat.camera.preset ?? null;
      }
      const rawGesture = beat.gesture ?? d.gesture ?? 'none';
      const kind = NEWS_GESTURE_TO_KIND[rawGesture] ?? 'none';

      const cues: Cue[] = [];
      // Camera: an authored pose (DATA) wins and is emitted once; else a catalog preset (by
      // name, runtime-resolved); else replace + carry-forward the shot-bucket frame cue.
      if (cameraPose) {
        if (!poseEmitted) {
          cues.push({ camera: { pose: cameraPose } });
          poseEmitted = true;
        }
      } else if (curPreset) {
        if (curPreset !== prevPreset) {
          cues.push({ camera: { preset: curPreset } });
          prevPreset = curPreset;
          prevSize = null; // a later shot-bucket change must re-emit its frame cue
        }
      } else if (curSize !== prevSize) {
        cues.push({ camera: { frame: { subjects: ['self.face'], size: curSize } } });
        prevSize = curSize;
        prevPreset = null; // a later preset change must re-emit
      }
      // Gesture: per-beat, emitted on change (mirrors compileNewsReport's motion cue gate).
      if (kind !== 'none' && kind !== prevGesture) {
        cues.push({ gesture: { kind } });
      }
      prevGesture = kind;
      // First beat of a section that changes emotion → an emote anchor (doc varies it per beat).
      if (sectionStart) sectionStart = false;

      beats.push({
        text: beat.text,
        emotion: curEmotion,
        cues,
        ...(beat.pause_ms_after ? { pauseMsAfter: beat.pause_ms_after } : {}),
      });
    }
  }

  return {
    stage: 'newsroom',
    defaults: { emotion: defEmotion },
    beats: beats.length > 0 ? beats : [{ text: '', emotion: defEmotion, cues: [] }],
  };
}

/**
 * Extract the NewsReport's music beds / SFX as AudioCue[] so they survive the Score path.
 * Each `section.audio` cue's section-relative `start` is re-based to an ABSOLUTE start
 * (`sectionStart + a.start`) using the SAME running clock + round1 as compileNewsReport, so the
 * two audio paths stay byte-identical; `defaults.music` becomes a full-timeline bed.
 * Pass the result as `compileScore(stage, score, timings, body, { audio })`.
 */
/**
 * The Score-path chrome channels for a lowered NewsReportDoc, timed on the SUPPLIED clock:
 * per-section audio (SFX/natpops) and wall slides start at the section's first beat's
 * `startSec` from `timings` — the SAME AudioTimings the Performance is compiled against, so
 * beds/SFX/slides and direction can never sit on different clocks (the old `newsReportAudio`
 * re-based sections on its own WPM estimate — a third clock). The music bed spans the real
 * total. Beat iteration order mirrors compileNewsReportToScore exactly (one Score beat per
 * doc beat), which is what makes the beat-index → section-start mapping sound.
 */
export function newsReportChrome(
  doc: NewsReportDoc,
  timings: AudioTimings,
): { audio: AudioCue[]; slides: { tSec: number; slide: SlideContent }[] } {
  const audio: AudioCue[] = [];
  const slides: { tSec: number; slide: SlideContent }[] = [];
  const total = timings.beats.at(-1)?.endSec ?? 0;
  let beatIdx = 0;
  for (const section of doc.rundown) {
    const sectionStart = timings.beats[beatIdx]?.startSec ?? 0;
    beatIdx += section.beats.length;
    slides.push({ tSec: round1(sectionStart), slide: sectionSlide(section, doc) });
    for (const a of section.audio) {
      audio.push({ ...a, start: round1(sectionStart + a.start) });
    }
  }
  const music = doc.defaults?.music;
  if (music) {
    audio.push({
      id: 'music-bed',
      kind: 'bed',
      src: music.src,
      start: 0,
      duration: total,
      volume: music.volume,
      fadeIn: music.fadeIn,
      fadeOut: music.fadeOut,
      label: 'music bed',
    });
  }
  return { audio, slides };
}

export function newsReportAudio(doc: NewsReportDoc, totalDuration: number): AudioCue[] {
  const out: AudioCue[] = [];
  // Mirror compileNewsReport's absolute timeline clock: t advances per beat by the estimated
  // duration plus the beat's trailing pause; sectionStart is captured before each section's beats.
  let t = 0;
  for (const section of doc.rundown) {
    const sectionStart = t;
    for (const beat of section.beats) {
      t += estDuration(beat.text) + (beat.pause_ms_after ?? 0) / 1000;
    }
    for (const a of section.audio) {
      out.push({ ...a, start: round1(sectionStart + a.start) });
    }
  }
  const music = doc.defaults?.music;
  if (music) {
    out.push({
      id: 'music-bed',
      kind: 'bed',
      src: music.src,
      start: 0,
      duration: totalDuration,
      volume: music.volume,
      fadeIn: music.fadeIn,
      fadeOut: music.fadeOut,
      label: 'music bed',
    });
  }
  return out;
}
