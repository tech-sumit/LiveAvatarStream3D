import type { AudioCue as ProtocolAudioCue, Performance, SlideContent } from '@las/protocol';
import { GESTURE_KIND_TO_CLIP, EMOTION_ENERGY } from '@las/protocol';
import type { GestureKind } from '@las/protocol';
import { CAMERA_SHOTS, resolveGesture, sampleShot } from '@las/performer-core';
import type { Pose as CorePose, Subject as CoreSubject } from '@las/performer-core';
import type { MouthCue } from '../avatar/avatarController.js';
import type { EmotionName } from '../avatar/emotion.js';
import { selectTalkClip } from '../avatar/gestures.js';
import { motionCueTurn } from '../timeline/motionCues.js';

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
  readonly idleMotion: boolean; // false → calm anchor: hold the speaking base to the calm talk pool
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
  /** Directly place the camera (authored static / move framing cues — follow:false keyframes). */
  setCameraPose(pos: Vec3Like, target: Vec3Like, fov?: number, roll?: number): void;
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
 * Sink for wall-slide changes — the studio's `setSlide`. Injected like the stage/avatar deps
 * so ScoreDrive stays THREE-free + headless-testable (the parity test injects a spy). The
 * studio's `Slide` is structurally identical to the protocol `SlideContent` carried here.
 */
export type SlideSink = (slide: SlideContent) => void;

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
  // Wall-slide one-shot cursor: the latest slide at-or-before t latches on its crossing (like
  // advanceScreen), so the wall graphics swap per section on both clocks without per-frame churn.
  private slideCursor = -1;
  private warnedNodeTarget = false;
  private lastT = -Infinity;
  // Camera follow seeding: false → the next follow frame snaps EXACTLY to the two-shot
  // (the frame-0 of a take/export, restoring the deleted export snap-override), then every
  // subsequent frame uses the shared 1-exp(-dt/0.45) ease. Re-armed on load / clock rewind.
  private cameraArmed = false;
  // Reused gaze/camera scratch so the per-frame look + authored-camera apply allocate nothing
  // (rule C): resolveTarget / advanceCamera mutate and hand these out instead of new literals.
  private readonly _gazeScratch = { x: 0, y: 0, z: 0 };
  private readonly _camPos = { x: 0, y: 0, z: 0 };
  private readonly _camTgt = { x: 0, y: 0, z: 0 };
  // Preset-keyframe resolution scratch (rule C — the per-frame camera path allocates nothing):
  // two reusable Subjects and the three subject-list shapes sampleShot can take.
  private readonly _presetAnchor: CoreSubject = { pos: [0, 0, 0], size: 1 };
  private readonly _presetScreen: CoreSubject = { pos: [0, 0, 0], size: 1 };
  private readonly _presetAnchorOnly: CoreSubject[] = [this._presetAnchor];
  private readonly _presetScreenOnly: CoreSubject[] = [this._presetScreen];
  private readonly _presetBoth: CoreSubject[] = [this._presetAnchor, this._presetScreen];
  private readonly _presetPose: CorePose = { pos: [0, 0, 0], target: [0, 0, 0], fov: 0 };

  constructor(
    private stage: StageLike,
    private avatar: AvatarLike,
    private screenAnchor: ScreenAnchor,
    private slideSink?: SlideSink,
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
    this.slideCursor = -1;
    this.lastT = -Infinity;
    this.cameraArmed = false;
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
    this.advanceSlide(perf, t);

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
    // Calm anchor (idleMotion off): hold the speaking base to the calm talk pool so the body
    // doesn't gesticulate wide mid-sentence; lively (idleMotion on) keeps the full energy pool.
    this.lastTalkClip = selectTalkClip(emotion, this.lastTalkClip, this.talkSeq++, !this.avatar.idleMotion);
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

    if (kf.preset) {
      // Catalog shot-preset keyframe: resolve against the LIVE avatar every frame (the
      // compile-time snapshot in pos/target/fov assumed a nominal head height). sampleShot
      // handles the push-in progression from t − tSec, dutch roll, and — because we re-sample
      // per frame — a walking anchor. Identical on the live and export clocks (live == export).
      const shot = CAMERA_SHOTS[kf.preset];
      if (shot) {
        const hc = this.avatar.headCenter;
        const root = this.avatar.group.position;
        this._presetAnchor.pos[0] = hc.x + root.x;
        this._presetAnchor.pos[1] = hc.y + root.y;
        this._presetAnchor.pos[2] = hc.z + root.z;
        this._presetAnchor.size = this.avatar.headHeight;
        this._presetScreen.pos[0] = this.screenAnchor.screen.x;
        this._presetScreen.pos[1] = this.screenAnchor.screen.y;
        this._presetScreen.pos[2] = this.screenAnchor.screen.z;
        const subjects =
          shot.subject === 'both'
            ? this._presetBoth
            : shot.subject === 'screen'
              ? this._presetScreenOnly
              : this._presetAnchorOnly;
        const pose = sampleShot(shot, subjects, Math.max(0, t - kf.tSec), this._presetPose);
        this._camPos.x = pose.pos[0];
        this._camPos.y = pose.pos[1];
        this._camPos.z = pose.pos[2];
        this._camTgt.x = pose.target[0];
        this._camTgt.y = pose.target[1];
        this._camTgt.z = pose.target[2];
        this.cameraArmed = true;
        this.stage.setCameraPose(this._camPos, this._camTgt, pose.fov, pose.roll ?? 0);
        return;
      }
      // Unknown preset id (schema carries plain string): fall through to the snapshot pose.
    }

    if (kf.follow) {
      // follow keyframe: re-frame the two-shot every frame against the live (walked) avatar
      // + the back-wall screen. The FIRST frame of a take/export snaps EXACTLY (restoring the
      // deleted export snap-override so frame 0 isn't an ease-in from the stale orbit pose);
      // every subsequent frame uses the SAME smoothed follow on both clocks (snap=false →
      // k = 1 - exp(-dt/0.45)), so live==export for frames ≥1 while frame 0 is the exact pose.
      const snap = !this.cameraArmed;
      this.cameraArmed = true;
      this.stage.frameAnchorScreen(this.avatar.group.position, this.screenAnchor.screen, dt, snap);
      return;
    }

    // Static / authored absolute framing keyframe (a follow:false cue, e.g. an authored
    // close-up): land the pose. The former TimelinePlayer.updateCamera applied these for
    // authored cues; on the unified drive path they were silently dropped. We re-apply them
    // here through StageLike.setCameraPose, held every frame while the keyframe is active.
    // Reused scratch keeps the per-frame path allocation-free (rule C).
    this._camPos.x = kf.pos[0];
    this._camPos.y = kf.pos[1];
    this._camPos.z = kf.pos[2];
    this._camTgt.x = kf.target[0];
    this._camTgt.y = kf.target[1];
    this._camTgt.z = kf.target[2];
    this.cameraArmed = true; // a later follow eases from this authored pose, not a hard snap
    this.stage.setCameraPose(this._camPos, this._camTgt, kf.fov, kf.roll ?? 0);
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

  // ── wall-slide channel (the video-wall slide deck, swapping per newscast section) ──
  // The LATEST slide at-or-before t wins; it fires once on its crossing via the injected
  // setSlide sink (the studio repaints the wall canvas). A forward cursor latch keeps this
  // allocation-free per frame (rule C): only an advance touches the sink, never a steady frame.
  private advanceSlide(perf: Performance, t: number): void {
    let idx = this.slideCursor;
    while (idx + 1 < perf.slides.length) {
      const next = perf.slides[idx + 1];
      if (!next || next.tSec > t) break;
      idx++;
      this.slideSink?.(next.slide);
    }
    this.slideCursor = idx;
  }

  // ── self.* / static target resolution (per-frame, against the live avatar) ──
  // self.face → headCenter + group.position; self.chest → a chest offset below it;
  // self.root → group.position. A static {pos} is the compiled world point. This is
  // the un-rooted-ref fix: the compiler NEVER bakes self.*; the runtime owns them.
  private resolveTarget(
    ref: { pos: [number, number, number] } | { bind: 'face' | 'chest' | 'root' } | { node: string },
  ): Vec3Like {
    // Mutate + return a reused scratch (rule C): advanceLook hands the result straight to
    // setGazeTarget, which is read out by avatar.update(dt) within THIS same frame, so a single
    // shared buffer never aliases across frames.
    const out = this._gazeScratch;
    if ('pos' in ref) {
      out.x = ref.pos[0];
      out.y = ref.pos[1];
      out.z = ref.pos[2];
      return out;
    }
    const gp = this.avatar.group.position;
    const hc = this.avatar.headCenter;
    if ('node' in ref) {
      // Node-bound target: AvatarLike exposes no arbitrary scene-graph lookup, so we can't yet
      // resolve a named node's world position here. Warn once and hold at the avatar root rather
      // than the silent compile-time [0,0,0]. (Full live-node resolution is a follow-up.)
      if (!this.warnedNodeTarget) {
        console.warn(`scoreDrive: node-bound target '${ref.node}' not yet resolvable at runtime; using avatar root`);
        this.warnedNodeTarget = true;
      }
      out.x = gp.x;
      out.y = gp.y;
      out.z = gp.z;
      return out;
    }
    switch (ref.bind) {
      case 'face':
        out.x = hc.x + gp.x;
        out.y = hc.y + gp.y;
        out.z = hc.z + gp.z;
        return out;
      case 'chest':
        // chest ≈ headCenter dropped ~0.4 m (the compiler's DEFAULT_BODY chest offset).
        out.x = hc.x + gp.x;
        out.y = hc.y + gp.y - 0.4;
        out.z = hc.z + gp.z;
        return out;
      case 'root':
      default:
        out.x = gp.x;
        out.y = gp.y;
        out.z = gp.z;
        return out;
    }
  }

  // Re-arm one-shot latches on a clock rewind (preview seek / restart).
  private rearm(): void {
    this.gestureCursor = -1;
    this.turnCursor = -1;
    this.lastEmoteIdx = -1;
    this.lastBeatIdx = -1;
    this.lastScreenActive = null;
    this.slideCursor = -1;
    this.lastTalkClip = 'idle';
    this.talkSeq = 0;
    this.cameraArmed = false;
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
//   - a follow:true two-shot camera keyframe (frame-0 snapped by ScoreDrive, then eased),
//     PLUS any authored timeline camera-track cues as follow:false absolute keyframes;
//   - the timeline's motion-track cues → the `turns`/`gestures` channels (same semantics as
//     catalog.applyMotion via the shared `motionCueTurn`), so the presenter turns/points/waves
//     on BOTH the live and export clocks (the Phase-4c cutover had dropped this);
//   - the timeline's `cam.screenSource` windows → the `screen` channel (montage sync), with
//     overlapping/nested windows merged to preserve the old updateScreenSource union.
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

/** A timeline motion-track cue: its start time + its catalog type (e.g. 'motion.turnScreen'). */
export interface MotionCue {
  t: number;
  type: string;
}

/** An authored timeline camera-track cue, already resolved to an absolute pose (follow:false). */
export interface CameraCue {
  tSec: number;
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  roll?: number; // dutch tilt (deg) from a catalog shot preset; default 0
}

/** A timeline graphics-track cue: the wall slide to show from `tSec` (mirrors a ScreenWindow). */
export interface SlideCue {
  tSec: number;
  slide: SlideContent;
}

/** Optional timeline channels folded into the narration Performance (mirrors `screens`). */
export interface NarrationExtras {
  motionCues?: MotionCue[];
  cameraCues?: CameraCue[];
  /** The audio-track cues (beds/SFX) → the Performance `audio` channel — perf.audio is the
   *  SINGLE audio source both the live scheduler and the export mixdown consume. */
  audioCues?: ProtocolAudioCue[];
  /** Wall-slide deck cues (the 'graphics' timeline track) → the Performance `slides` channel. */
  slideCues?: SlideCue[];
  /** Emit the two-shot follow keyframe (default true); live free-text Speak passes the
   *  Auto-align toggle so a user who disabled it keeps their manually-framed camera. */
  followCamera?: boolean;
}

const POSTURE_OF: Record<'low' | 'med' | 'high', 'relaxed' | 'neutral' | 'leaning_in'> = {
  low: 'relaxed',
  med: 'neutral',
  high: 'leaning_in',
};

// Motion cue → the GestureKind that plays it on the unified score.drive `gestures` channel
// (the turn part is sourced separately from the shared `motionCueTurn`). turnScreen/faceFront
// only turn — no gesture clip. This keeps the take/export on the SAME gesture machinery the
// narration segments use, instead of the preview-only raw playClip in catalog.applyMotion.
const MOTION_GESTURE: Record<string, GestureKind | undefined> = {
  'motion.point': 'point',
  'motion.wave': 'wave',
  'motion.nod': 'nod',
  'motion.explain': 'explain',
};

export function buildNarrationPerformance(
  segs: NarrationSeg[],
  durationSec: number,
  screens: ScreenWindow[] = [],
  fallbackEmotion: EmotionName = 'neutral',
  extra: NarrationExtras = {},
): Performance {
  const beats: Performance['beats'] = [];
  const gestures: Performance['gestures'] = [];
  const turns: Performance['turns'] = [];
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

  // Timeline motion-track cues → the SAME turns[]/gestures[] channels the score already
  // consumes, with the SAME semantics as catalog.applyMotion (shared `motionCueTurn`): a
  // 'motion.turnScreen' cue at t becomes setTurn(0.6) at t on both the live and export clocks.
  for (const m of extra.motionCues ?? []) {
    const yaw = motionCueTurn(m.type);
    if (yaw !== undefined) turns.push({ tSec: m.t, yaw });
    const gk = MOTION_GESTURE[m.type];
    if (gk) {
      const gd = resolveGesture(gk);
      const gDrive: Performance['gestures'][number]['drive'] = { kind: gd.kind, baseEnergy: 'med' };
      if (gd.clip !== undefined) gDrive.clip = gd.clip;
      if (gd.ik !== undefined) gDrive.ik = gd.ik;
      gestures.push({ tSec: m.t, kind: gk, drive: gDrive });
    }
  }
  // The one-shot turn/gesture cursors latch forward, so both channels MUST be ascending.
  turns.sort((a, b) => a.tSec - b.tSec);
  gestures.sort((a, b) => a.tSec - b.tSec);

  // Camera channel. The two-shot follow keyframe (presenter beside the screen) is re-framed
  // every frame against self.root + the back-wall screen — the unified camera both clocks
  // share; emitted unless followCamera is disabled (live free-text Speak with Auto-align off).
  // Authored timeline framing cues (follow:false) are layered on top so the unified path
  // honors them (they were silently dropped after the Phase-4c cutover); advanceCamera picks
  // the latest keyframe at-or-before t, so the follow covers the gaps before/between cues.
  const camera: Performance['camera'] = [];
  if (extra.followCamera ?? true) {
    camera.push({ tSec: 0, pos: [0, 0, 0], target: [0, 0, 0], fov: 0, roll: 0, follow: true, followSubjects: [{ bind: 'root' }] });
  }
  for (const c of extra.cameraCues ?? []) {
    camera.push({ tSec: c.tSec, pos: c.pos, target: c.target, fov: c.fov, roll: c.roll ?? 0, follow: false });
  }
  // Stable sort keeps the follow keyframe BEFORE an authored cue at the same tSec, so an
  // authored framing at t=0 wins over the follow there (advanceCamera takes the later index).
  camera.sort((a, b) => a.tSec - b.tSec);

  // Screen-cut windows → start/end marks (source 'screen' on, 'scene' off). Overlapping /
  // nested windows are MERGED so the latest-mark-wins reducer in advanceScreen reproduces the
  // old updateScreenSource `.some()` union (a still-open outer window isn't ended when a nested
  // inner window closes).
  const screen: Performance['screen'] = [];
  const ivals = screens
    .map((w) => ({ s: w.start, e: w.start + w.duration }))
    .filter((iv) => iv.e > iv.s)
    .sort((a, b) => a.s - b.s);
  let cur: { s: number; e: number } | null = null;
  const flush = (iv: { s: number; e: number }): void => {
    screen.push({ tSec: iv.s, source: 'screen' });
    screen.push({ tSec: iv.e, source: 'scene' });
  };
  for (const iv of ivals) {
    if (cur && iv.s <= cur.e) cur.e = Math.max(cur.e, iv.e); // overlap / adjacent → extend
    else {
      if (cur) flush(cur);
      cur = { s: iv.s, e: iv.e };
    }
  }
  if (cur) flush(cur);

  // Wall-slide deck → the `slides` channel (the 'graphics' timeline track). Each slide latches
  // until the next (advanceSlide's forward cursor). Seed t=0 so the FIRST slide shows from frame
  // 0 even if the earliest authored cue starts later — pull a copy back to 0 (live == export).
  const slides: Performance['slides'] = [];
  for (const s of extra.slideCues ?? []) slides.push({ tSec: s.tSec, slide: s.slide });
  slides.sort((a, b) => a.tSec - b.tSec);
  const first = slides[0];
  if (first && first.tSec > 0) slides.unshift({ tSec: 0, slide: first.slide });

  return {
    stageId: 'studio',
    durationSec,
    beats,
    camera,
    motion: [],
    turns,
    gestures,
    looks: [],
    emotes: [],
    screen,
    slides,
    audio: [...(extra.audioCues ?? [])],
  };
}
