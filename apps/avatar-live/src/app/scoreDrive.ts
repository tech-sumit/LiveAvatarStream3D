import type { Performance } from '@las/protocol';
import { GESTURE_KIND_TO_CLIP, EMOTION_ENERGY } from '@las/protocol';
import type { GestureKind } from '@las/protocol';
import { resolveGesture } from '@las/performer-core';
import type { MouthCue } from '../avatar/avatarController.js';
import type { EmotionName } from '../avatar/emotion.js';
import { selectTalkClip } from '../avatar/gestures.js';

// ─────────────────────────────────────────────────────────────────────────────
// ScoreDrive — the SINGLE per-frame drive path shared by the live narration tick
// and the frame-exact offline export (Phase 4c).
//
// Before this, the live tick (performer.ts) and the export closure each advanced
// the avatar/camera/screen on their OWN code, which is exactly why they diverged
// (the documented camera override, mouth source, gesture rotation, and clock).
// `drive(t, dt, mouth)` consumes ONE compiled `Performance` (from @las/protocol's
// compileScore, or the studio's buildPerformance) and issues all per-frame
// commands from it — so live==export by construction.
//
// It depends ONLY on the injected `StageLike` / `AvatarLike` interfaces (NOT on
// concrete THREE objects), so the parity test drives it headless against fake
// stage/avatar spies — no WebGL / GLB / AudioContext. `mouth` is an INJECTED input
// (live `analyser.sample()` / offline `precomputeMouthTrack`), never computed here;
// that injected difference is the ONLY legitimate live-vs-export difference left.
// ─────────────────────────────────────────────────────────────────────────────

/** A world point with x/y/z — THREE.Vector3 satisfies this structurally. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The avatar surface `drive` writes to / reads from. The real `AvatarController`
 * satisfies this; the parity test injects a spy. Positions are read structurally
 * (x/y/z) so `self.*` body refs resolve per-frame against the live (walked) avatar.
 */
export interface AvatarLike {
  readonly headCenter: Vec3Like; // local head centre (camera framing / face ref)
  readonly headHeight: number;
  readonly group: { readonly position: Vec3Like }; // world root (walked); self.root
  readonly animationClips: string[]; // gates talk-clip selection (empty → no body clips)
  setMouth(cue: MouthCue): void;
  setEmotion(name: EmotionName, intensity?: number): void;
  setTurn(yaw: number): void;
  setGazeTarget(target: Vec3Like | null): void;
  playGesture(gestureName: string, baseClip: string): void;
  playClip(name: string): void;
  update(dt: number): void;
}

/**
 * The stage/camera surface `drive` writes to. The real `Stage` satisfies this; the
 * parity test injects a spy that records the calls. `frameAnchorScreen` carries its
 * OWN τ=0.45 follow damping — the live/export difference is the `dt` fed to it, never
 * a `snap` boolean (the deleted `performer.ts:253` override), so the follow lag is
 * identical on both clocks.
 */
export interface StageLike {
  /** The world point the eyes track (today's gaze datum). */
  cameraWorldPosition(): Vec3Like;
  /**
   * Frame the anchor + screen two-shot, smoothly following the anchor. `snap`
   * defaults to the smoothed follow (k = 1 - exp(-dt/0.45)); the unified path NEVER
   * passes snap=true (that was the export-only override that diverged from live).
   */
  frameAnchorScreen(anchor: Vec3Like, screen: Vec3Like, dt: number, snap?: boolean): void;
  /** Scrub the back-wall montage video to time t (seekable for the frame-stepped export). */
  seekScreen(t: number): void;
  /** Vision-mixer cut: while active, the recorded output is the wall/cast video. */
  setScreenCut(active: boolean): void;
}

/** Where the stand-mounted screen sits — the two-shot's second subject (the back wall). */
export interface ScreenAnchor {
  readonly screen: Vec3Like;
}

/**
 * Consumes a compiled `Performance` and drives the injected stage + avatar each
 * frame. ONE instance feeds both the live narration tick and the offline export
 * (the same object, the same `Performance`), so the two paths cannot diverge.
 */
export class ScoreDrive {
  private perf: Performance | null = null;
  private fallbackEmotion: EmotionName = 'neutral';

  // Caller-owned talk-clip rotation (replaces the former module-global `rotation`):
  // a monotonically-increasing seq makes selectTalkClip pure, so the chosen clip
  // sequence is identical on the live and export clocks. Advanced once per gesture
  // one-shot (each gesture/emotion change), keyed by the timed event — NOT per frame.
  private lastTalkClip = 'idle';
  private talkSeq = 0;

  // One-shot latches keyed by the Performance event INDEX (so a gesture/turn fires
  // exactly once when t crosses its tSec, on whichever clock — never re-fires, never
  // diverges between live and export). Reset on load() and on a clock rewind (seek<last).
  private gestureCursor = -1;
  private turnCursor = -1;
  private lastEmoteIdx = -1;
  private lastBeatIdx = -1;
  private lastScreenActive: boolean | null = null;
  private lastT = -Infinity;

  constructor(
    private stage: StageLike,
    private avatar: AvatarLike,
    private screenAnchor: ScreenAnchor,
  ) {}

  /** Load the Performance the drive consumes, resetting all one-shot cursors. */
  load(perf: Performance, fallbackEmotion: EmotionName = 'neutral'): void {
    this.perf = perf;
    this.fallbackEmotion = fallbackEmotion;
    this.reset();
  }

  /**
   * Swap to an incrementally-grown Performance WITHOUT resetting the one-shot cursors —
   * for live free-text Speak, where each new segment APPENDS a gesture/beat at the current
   * clock. Keeping the cursors means only the newly-appended events fire on the next drive
   * (prior gestures already fired and must NOT replay). The new Performance must be a
   * forward-extension of the old (same earlier events + appended ones). Talk-clip rotation
   * state (lastTalkClip/talkSeq) is preserved so the sequence stays deterministic.
   */
  reload(perf: Performance, fallbackEmotion: EmotionName = 'neutral'): void {
    this.perf = perf;
    this.fallbackEmotion = fallbackEmotion;
    // Clamp cursors into the new arrays (they only grow, so this is normally a no-op).
    this.gestureCursor = Math.min(this.gestureCursor, perf.gestures.length - 1);
    this.turnCursor = Math.min(this.turnCursor, perf.turns.length - 1);
  }

  /** Reset the per-run latches (call before replaying from t=0). */
  reset(): void {
    this.lastTalkClip = 'idle';
    this.talkSeq = 0;
    this.gestureCursor = -1;
    this.turnCursor = -1;
    this.lastEmoteIdx = -1;
    this.lastBeatIdx = -1;
    this.lastScreenActive = null;
    this.lastT = -Infinity;
  }

  /**
   * The single per-frame drive. For time `t` (seconds) it advances emotion, gesture,
   * turn, look, camera, and the screen channel from the loaded `Performance`, sets the
   * INJECTED mouth, then steps the avatar by `dt`. Identical commands on the live and
   * export clocks (modulo the injected mouth). Allocation-free in steady state (rule C):
   * no `new` on this path — `frameAnchorScreen` owns its own reused THREE scratch.
   */
  drive(t: number, dt: number, mouth: MouthCue): void {
    const perf = this.perf;
    const { avatar } = this;

    // A clock rewind (preview seek / a fresh take) re-arms the one-shot latches so the
    // events fire again on the way forward. Forward stepping keeps them latched.
    if (t < this.lastT) this.rearm();
    this.lastT = t;

    avatar.setMouth(mouth);

    if (!perf) {
      avatar.setGazeTarget(this.stage.cameraWorldPosition());
      avatar.update(dt);
      return;
    }

    this.advanceEmotion(perf, t);
    this.advanceGesture(perf, t);
    this.advanceTurn(perf, t);
    this.advanceLook(perf, t);
    this.advanceCamera(perf, t, dt);
    this.advanceScreen(perf, t);

    avatar.update(dt);
  }

  // ── emotion ──────────────────────────────────────────────────────────────
  // The active beat's emotion is the sticky base; a timed `emote` anchor overrides
  // its intensity (and emotion) the moment t crosses the anchor. Both flow to
  // setEmotion(name, intensity) — the same call the old driveAvatarFrame made, now
  // also carrying intensity (the emote channel the old flat-array path dropped).
  private advanceEmotion(perf: Performance, t: number): void {
    // Latest emote anchor at-or-before t (one-shot apply on the crossing).
    let emoIdx = -1;
    for (let i = 0; i < perf.emotes.length; i++) {
      const e = perf.emotes[i];
      if (e && e.tSec <= t) emoIdx = i;
      else break;
    }
    // Active beat (for the sticky emotion when no emote anchor leads it).
    let beatIdx = -1;
    for (let i = 0; i < perf.beats.length; i++) {
      const b = perf.beats[i];
      if (b && b.startSec <= t) beatIdx = i;
      else break;
    }

    const emote = emoIdx >= 0 ? perf.emotes[emoIdx] : undefined;
    const beat = beatIdx >= 0 ? perf.beats[beatIdx] : undefined;

    // Re-apply only when the controlling event changed (avoids fighting the
    // controller's own emotion smoothing every frame).
    if (emoIdx !== this.lastEmoteIdx || beatIdx !== this.lastBeatIdx) {
      this.lastEmoteIdx = emoIdx;
      this.lastBeatIdx = beatIdx;
      if (emote) {
        avatarSetEmotion(this.avatar, emote.emotion, emote.intensity);
      } else if (beat) {
        avatarSetEmotion(this.avatar, beat.emotion, beat.intensity);
      } else {
        avatarSetEmotion(this.avatar, this.fallbackEmotion, 1);
      }
    }
  }

  // ── gesture (timed one-shot) ───────────────────────────────────────────────
  // Each ResolvedGesture fires once when t crosses its tSec: pick the talk-base clip
  // from drive.baseEnergy (deterministic, caller-owned seq — the divergence fix), then
  // either play a dedicated gesture clip OVER it, or play the base alone. The drive.kind
  // (clip / ik / none) + GESTURE_KIND_TO_CLIP decide the overlay, exactly like the old
  // gestureClipFor → playGesture, now sourced from the Performance.
  private advanceGesture(perf: Performance, t: number): void {
    let idx = this.gestureCursor;
    while (idx + 1 < perf.gestures.length) {
      const next = perf.gestures[idx + 1];
      if (!next || next.tSec > t) break;
      idx++;
      this.applyGesture(next);
    }
    this.gestureCursor = idx;
  }

  private applyGesture(g: Performance['gestures'][number]): void {
    if (this.avatar.animationClips.length === 0) return;
    const energy = g.drive.baseEnergy ?? 'med';
    const emotion = bucketEmotion(energy);
    this.lastTalkClip = selectTalkClip(emotion, this.lastTalkClip, this.talkSeq++);
    const overlay = overlayClipFor(g);
    if (overlay) this.avatar.playGesture(overlay, this.lastTalkClip);
    else this.avatar.playClip(this.lastTalkClip);
  }

  // ── turn (timed one-shot) ──────────────────────────────────────────────────
  private advanceTurn(perf: Performance, t: number): void {
    let idx = this.turnCursor;
    while (idx + 1 < perf.turns.length) {
      const next = perf.turns[idx + 1];
      if (!next || next.tSec > t) break;
      idx++;
      this.avatar.setTurn(next.yaw);
    }
    this.turnCursor = idx;
  }

  // ── look (per-frame; BodyRef resolved against the live avatar) ──────────────
  // The latest look at-or-before t sets the gaze target. A static {pos} is used
  // verbatim; a self.* BodyRef is resolved EVERY frame against the walked avatar
  // (face → headCenter + group.position, etc.) — exactly how today's gaze tracks the
  // camera, now generalized. With no look authored, gaze tracks the camera (the
  // historical default during a take).
  private advanceLook(perf: Performance, t: number): void {
    let look: Performance['looks'][number] | undefined;
    for (let i = 0; i < perf.looks.length; i++) {
      const l = perf.looks[i];
      if (l && l.tSec <= t) look = l;
      else break;
    }
    if (!look) {
      this.avatar.setGazeTarget(this.stage.cameraWorldPosition());
      return;
    }
    this.avatar.setGazeTarget(this.resolveTarget(look.target));
  }

  // ── camera (per-frame; relative move + follow re-framed against the avatar) ──
  private advanceCamera(perf: Performance, t: number, dt: number): void {
    // Active keyframe at-or-before t.
    let idx = -1;
    for (let i = 0; i < perf.camera.length; i++) {
      const kf = perf.camera[i];
      if (kf && kf.tSec <= t) idx = i;
      else break;
    }
    if (idx < 0) return;
    const kf = perf.camera[idx];
    if (!kf) return;

    // follow keyframe: re-frame the two-shot every frame against the live (walked)
    // avatar + the back-wall screen. The SAME smoothed follow runs on both clocks
    // (snap=false → k = 1 - exp(-dt/0.45)); the deleted snap-override is gone.
    if (kf.follow) {
      this.stage.frameAnchorScreen(this.avatar.group.position, this.screenAnchor.screen, dt, false);
    }
    // Static / relative-move keyframes carry their absolute pose in the Performance;
    // the existing TimelinePlayer applies those for authored framing cues (preview),
    // and the studio's narration Performance uses the follow keyframe above. No hard
    // setCameraPose here keeps the two paths on the single follow term they share.
  }

  // ── screen channel (back-wall montage cut, frame-seekable for export) ───────
  private advanceScreen(perf: Performance, t: number): void {
    if (perf.screen.length === 0) {
      // No cut authored: still seek the wall video so a montage advances in lockstep
      // with the frame clock (the Jun-19 export-sync behavior), but don't touch the cut.
      this.stage.seekScreen(t);
      return;
    }
    // The LATEST cut at-or-before t wins; active iff its source is the screen feed. The
    // studio emits start/end marks (source 'screen' at the cut start, 'scene' at its end)
    // so a windowed "cut to screen" cue is preserved exactly (the old updateScreenSource
    // window), while a bare "go to screen" mark just latches on.
    let active = false;
    for (let i = 0; i < perf.screen.length; i++) {
      const cut = perf.screen[i];
      if (cut && cut.tSec <= t) active = cut.source === 'screen';
      else break;
    }
    if (active !== this.lastScreenActive) {
      this.lastScreenActive = active;
      this.stage.setScreenCut(active);
    }
    this.stage.seekScreen(t);
  }

  // ── self.* / static target resolution (per-frame, against the live avatar) ──
  // self.face → headCenter + group.position; self.chest → a chest offset below it;
  // self.root → group.position. A static {pos} is the compiled world point. This is
  // the un-rooted-ref fix: the compiler NEVER bakes self.*; the runtime owns them.
  private resolveTarget(ref: { pos: [number, number, number] } | { bind: 'face' | 'chest' | 'root' }): Vec3Like {
    if ('pos' in ref) {
      return { x: ref.pos[0], y: ref.pos[1], z: ref.pos[2] };
    }
    const gp = this.avatar.group.position;
    const hc = this.avatar.headCenter;
    switch (ref.bind) {
      case 'face':
        return { x: hc.x + gp.x, y: hc.y + gp.y, z: hc.z + gp.z };
      case 'chest':
        // chest ≈ headCenter dropped ~0.4 m (the compiler's DEFAULT_BODY chest offset).
        return { x: hc.x + gp.x, y: hc.y + gp.y - 0.4, z: hc.z + gp.z };
      case 'root':
      default:
        return { x: gp.x, y: gp.y, z: gp.z };
    }
  }

  // Re-arm one-shot latches on a clock rewind (preview seek / restart).
  private rearm(): void {
    this.gestureCursor = -1;
    this.turnCursor = -1;
    this.lastEmoteIdx = -1;
    this.lastBeatIdx = -1;
    this.lastScreenActive = null;
    this.lastTalkClip = 'idle';
    this.talkSeq = 0;
  }
}

// setEmotion takes the avatar-live EmotionName; the Performance's EmotionPreset is the
// SAME string union (protocol's EmotionPreset == avatar/emotion.ts EmotionName), so the
// cast is a no-op widening, isolated to this one boundary helper.
function avatarSetEmotion(avatar: AvatarLike, emotion: string, intensity: number): void {
  avatar.setEmotion(emotion as EmotionName, intensity);
}

// energy bucket → a representative emotion for selectTalkClip's EMOTION_ENERGY lookup.
// selectTalkClip buckets BY emotion, so we hand it an emotion whose energy equals the
// resolved baseEnergy — keeping the talk-clip pool identical to the old emotion-driven
// path while sourcing energy from the (deterministic) Performance, not a module global.
function bucketEmotion(energy: 'low' | 'med' | 'high'): EmotionName {
  return energy === 'low' ? 'sad' : energy === 'high' ? 'excited' : 'neutral';
}

// The dedicated one-shot clip to overlay for a resolved gesture, or null when it's
// plain talking (none/explain) or IK-driven (point/count) — both detected downstream by
// avatarController.playGesture (a 'point'/'count' trigger clip name), so the historical
// point/count behavior is preserved. Mirrors gestures.ts gestureClipFor, now reading the
// already-resolved drive from the Performance instead of re-resolving the kind.
function overlayClipFor(g: Performance['gestures'][number]): string | null {
  const drive = g.drive;
  if (drive.kind === 'clip') return drive.clip ?? GESTURE_KIND_TO_CLIP[g.kind] ?? null;
  if (drive.kind === 'ik') return drive.ik === 'count' ? 'count' : 'point';
  return null; // 'none' / 'explain' → no overlay, just the talk base
}

// ─────────────────────────────────────────────────────────────────────────────
// buildNarrationPerformance — the studio's narration → Performance adapter.
//
// The studio authors narration as a flat segment list (parseScriptLine per sentence)
// + a timeline (the screen-cut cues). It has no Stage/Score yet, so rather than route
// through compileScore it builds the low-level `Performance` directly here — the SAME
// shape compileScore emits, so ScoreDrive consumes both identically. This is the
// replacement for performer.ts's `narrationSegs` flat array + `{idx}` cursor (Task 4):
//   - each segment → one timed gesture (kind from parseScriptLine; drive + baseEnergy
//     resolved deterministically) + one beat projection (emotion/gesture/posture);
//   - a single follow:true camera keyframe → the two-shot the export used to apply via
//     the (now deleted) snap-override, NOW applied to live AND export off one term;
//   - the timeline's `cam.screenSource` windows → the `screen` channel (montage sync).
// ─────────────────────────────────────────────────────────────────────────────

/** A parsed narration segment (parseScriptLine output + its absolute start time). */
export interface NarrationSeg {
  t: number;
  gesture: GestureKind;
  emotion?: EmotionName;
}

/** A timeline screen-cut window (the historical `cam.screenSource` cue). */
export interface ScreenWindow {
  start: number;
  duration: number;
}

const POSTURE_OF: Record<'low' | 'med' | 'high', 'relaxed' | 'neutral' | 'leaning_in'> = {
  low: 'relaxed',
  med: 'neutral',
  high: 'leaning_in',
};

export function buildNarrationPerformance(
  segs: NarrationSeg[],
  durationSec: number,
  screens: ScreenWindow[] = [],
  fallbackEmotion: EmotionName = 'neutral',
): Performance {
  const beats: Performance['beats'] = [];
  const gestures: Performance['gestures'] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg) continue;
    const emotion = (seg.emotion ?? fallbackEmotion) as EmotionName;
    const next = segs[i + 1];
    const endSec = next ? next.t : durationSec;
    const kind = seg.gesture;
    const baseEnergy = EMOTION_ENERGY[emotion] ?? 'med';
    const d = resolveGesture(kind);
    const drive: Performance['gestures'][number]['drive'] = { kind: d.kind, baseEnergy };
    if (d.clip !== undefined) drive.clip = d.clip;
    if (d.ik !== undefined) drive.ik = d.ik;
    gestures.push({ tSec: seg.t, kind, drive });
    beats.push({
      startSec: seg.t,
      endSec,
      text: '',
      emotion,
      intensity: 1,
      gesture: kind,
      posture: POSTURE_OF[baseEnergy],
    });
  }

  // The two-shot follow keyframe (presenter beside the screen): re-framed every frame
  // against self.root (the walked avatar) + the back-wall screen. This is the unified
  // camera both clocks now share.
  const camera: Performance['camera'] = [
    { tSec: 0, pos: [0, 0, 0], target: [0, 0, 0], fov: 0, follow: true, followSubjects: [{ bind: 'root' }] },
  ];

  // Screen-cut windows → start/end marks (source 'screen' on, 'scene' off), sorted by tSec.
  const screen: Performance['screen'] = [];
  for (const w of screens) {
    screen.push({ tSec: w.start, source: 'screen' });
    screen.push({ tSec: w.start + w.duration, source: 'scene' });
  }
  screen.sort((a, b) => a.tSec - b.tSec);

  return {
    stageId: 'studio',
    durationSec,
    beats,
    camera,
    motion: [],
    turns: [],
    gestures,
    looks: [],
    emotes: [],
    screen,
    audio: [],
  };
}
