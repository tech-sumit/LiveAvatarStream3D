import { BoundaryLipsync } from '../lipsync/boundaryLipsync.js';
import { AudioAnalyserLipsync } from '../lipsync/audioLipsync.js';
import { RealtimeSession } from '../session/realtimeSession.js';
import { parseScriptLine, type Gesture } from '../avatar/gestures.js';
import { exportMp4Offline } from '../capture/offlineExporter.js';
import { audioCuesToClips } from '../capture/offlineAudio.js';
import { canExportMp4 } from '../capture/mp4Encoder.js';
import { cueId, type Cue } from '../timeline/types.js';
import { SCREEN_STAND_POS } from '../scene/studio.js';
import { ScoreDrive, buildNarrationPerformance, type NarrationSeg } from './scoreDrive.js';
import type { Performance } from '@las/protocol';
import type { EmotionName } from '../avatar/emotion.js';
import type { StudioContext } from './context.js';
import type { VoicePicker } from './voicePicker.js';
import type { Recording } from './recording.js';
import type { AvatarLibrary } from './avatarLibrary.js';
import type { TimelineEditor } from './timelineEditor.js';
import type { AvatarTransform } from './avatarTransform.js';

interface RenderState {
  ctx: AudioContext;
  start: number;
  analyser: AudioAnalyserLipsync;
}

export interface PerformerDeps {
  voices: VoicePicker;
  recording: Recording;
  library: AvatarLibrary;
  timeline: TimelineEditor;
  transform: AvatarTransform;
}

/** The speak/perform engine: live TTS session, pre-rendered narration, the synced
 *  render loop (lip-sync + motion + camera off one clock), and recording. */
export class Performer {
  private boundary: BoundaryLipsync;
  private analyser: AudioAnalyserLipsync | null = null;
  private _speaking = false;
  // The SINGLE per-frame drive path: both the live narration tick and the offline
  // export call `score.drive(t, dt, mouth)` on THIS object, consuming ONE Performance,
  // so the camera/gesture/emotion/turn/look/screen can no longer diverge between the
  // two clocks. The former module-global talk-clip rotation + the live/export camera
  // override now live inside ScoreDrive.
  private score: ScoreDrive;
  // Live free-text Speak builds an incremental Performance fed to the SAME score.drive
  // (no second drive path) — appended to as segments stream in.
  private liveSegs: NarrationSeg[] = [];
  private liveClock = 0; // seconds since the current live-speak run started
  private render: RenderState | null = null;
  private renderSrc: AudioBufferSourceNode | null = null;
  private narrationAudio: AudioBuffer | null = null;
  private narrationSegs: NarrationSeg[] = [];
  // An externally-authored Performance landed via loadPerformance (the Score/bridge path). When
  // present it OWNS the next live take and export — the script-derived buildNarrationPerformance
  // rebuild is bypassed so authored camera/motion/audio survive identically on both clocks
  // (live == export). Cleared by invalidateNarration: any script edit drops back to the
  // script-derived take.
  private authoredPerf: Performance | null = null;
  private exporting = false;
  private performing = false; // guards re-entry while synthesizing / playing
  private session: RealtimeSession;

  constructor(
    private app: StudioContext,
    private deps: PerformerDeps,
  ) {
    this.boundary = new BoundaryLipsync(Number(app.dom.rateEl.value));
    // Inject the wall-slide sink (the studio repaints its canvas) alongside the stage/avatar deps,
    // so the unified score.drive swaps the video-wall slide deck per section on both clocks.
    this.score = new ScoreDrive(app.stage, app.avatar, { screen: SCREEN_STAND_POS }, (slide) => app.studio.setSlide(slide));
    this.session = new RealtimeSession(
      () => deps.voices.activeTts,
      deps.voices.ttsOpts,
      {
        onWord: (word, atMs) => {
          this._speaking = true;
          this.boundary.noteWord(word, atMs);
        },
        onAudioNode: (ctx, node) => {
          this.analyser = new AudioAnalyserLipsync(ctx, node, deps.library.lip.smoothing);
          this._speaking = true;
        },
        onSegmentStart: (_text, gesture, emotion) => {
          const fresh = !this._speaking;
          if (fresh) {
            // A fresh live-speak run — reset the incremental Performance + clock.
            this.liveSegs = [];
            this.liveClock = 0;
          }
          this._speaking = true;
          const emo = (emotion as EmotionName) ?? (app.dom.emotionSel.value as EmotionName);
          // Append this segment to the live Performance at the CURRENT clock; the SAME
          // score.drive applies its emotion + gesture one-shot (no second drive path). A
          // fresh run loads (resets cursors); subsequent segments reload (KEEP cursors) so
          // only the newly-appended gesture fires — prior gestures don't replay.
          this.liveSegs.push({ t: this.liveClock, gesture: (gesture as Gesture) ?? 'explain', emotion: emo });
          // followCamera honors the Auto-align toggle: with it OFF the live Speak Performance
          // emits NO follow keyframe, so the user's manually-framed camera is preserved (instead
          // of being yanked to the two-shot). Narration/export always frame (default true).
          const perf = buildNarrationPerformance(this.liveSegs, this.liveClock + 1e6, [], emo, {
            followCamera: deps.transform.isAutoAlign,
          });
          if (fresh) this.score.load(perf, emo);
          else this.score.reload(perf, emo);
        },
        onIdle: () => {
          this._speaking = false;
          app.avatar.restToIdle();
          this.analyser = null;
          app.log('idle');
          this.setSpeakingUi(false);
        },
        onStatus: (m) => app.log(m),
      },
      parseScriptLine,
    );
  }

  get busy(): boolean {
    return this.performing || this.render != null || this.exporting;
  }
  get isRendering(): boolean {
    return this.render != null;
  }
  get hasNarration(): boolean {
    return this.narrationAudio != null;
  }
  get speaking(): boolean {
    return this._speaking;
  }
  setRate(n: number): void {
    this.boundary.setRate(n);
  }
  invalidateNarration(): void {
    this.narrationAudio = null;
    this.authoredPerf = null; // a script change supersedes any landed authored Performance
  }

  private setSpeakingUi(on: boolean): void {
    this.app.dom.speakBtn.disabled = on;
    this.app.dom.stopBtn.disabled = !on;
  }

  private monoData(b: AudioBuffer): Float32Array {
    if (b.numberOfChannels === 1) return b.getChannelData(0);
    const out = new Float32Array(b.length);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < b.length; i++) out[i] += d[i] / b.numberOfChannels;
    }
    return out;
  }

  buildNarration = async (): Promise<boolean> => {
    const { app, deps } = this;
    const activeTts = deps.voices.activeTts;
    if (!activeTts.synthesize) {
      app.log('narration needs ElevenLabs — add ELEVENLABS_API_KEY to apps/avatar-live/.env.');
      return false;
    }
    const lines = app.dom.scriptEl.value
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) {
      app.log('nothing to generate — script is empty.');
      return false;
    }
    const segs = lines.map(parseScriptLine);
    const ctx = app.audio();
    await ctx.resume();
    app.log(`narration: synthesizing ${segs.length} sentence(s)…`);
    let buffers: AudioBuffer[];
    try {
      buffers = await Promise.all(segs.map((s) => activeTts.synthesize!(s.text, deps.voices.ttsOpts())));
    } catch (err) {
      app.log(`narration failed (TTS): ${String(err)}`);
      return false;
    }

    const sr = buffers[0].sampleRate;
    const gap = Math.round(sr * 0.18);
    const total = buffers.reduce((a, b) => a + b.length + gap, 0);
    const out = ctx.createBuffer(1, total, sr);
    const od = out.getChannelData(0);
    const segTimeline: NarrationSeg[] = [];
    const cues: Cue[] = [];
    let off = 0;
    buffers.forEach((b, i) => {
      od.set(this.monoData(b), off);
      const t = off / sr;
      segTimeline.push({ t, gesture: segs[i].gesture, emotion: segs[i].emotion });
      cues.push({
        id: cueId(),
        track: 'narration',
        type: 'narration',
        start: Math.round(t * 10) / 10,
        duration: Math.round((b.length / sr) * 10) / 10,
        text: segs[i].text,
        gesture: segs[i].gesture,
        emotion: segs[i].emotion,
      });
      off += b.length + gap;
    });

    this.narrationAudio = out;
    this.narrationSegs = segTimeline;
    deps.timeline.setNarrationCues(cues, total / sr);
    app.log(`narration ready · ${(total / sr).toFixed(1)}s, ${cues.length} sentence(s). Preview to play it.`);
    return true;
  };

  /** Build (or reuse) narration and return the pieces the offline exporter needs. */
  private async prepareForExport(): Promise<
    { buffer: AudioBuffer; segs: NarrationSeg[]; durationSec: number } | null
  > {
    if (!this.narrationAudio) {
      if (!(await this.buildNarration())) return null;
    }
    const buffer = this.narrationAudio!;
    return { buffer, segs: this.narrationSegs, durationSec: buffer.length / buffer.sampleRate };
  }

  /** Frame-exact offline MP4 export of the current script at the selected resolution + codec. */
  exportMp4 = async (): Promise<void> => {
    const { app, deps } = this;
    if (this.exporting || app.isBusy()) {
      app.log('finish the current take before exporting.');
      return;
    }
    const prep = await this.prepareForExport();
    if (!prep) return; // buildNarration already logged why
    const fmt = deps.recording.currentFormat();
    if (!(await canExportMp4(fmt.w, fmt.h))) {
      app.log('MP4/WebCodecs unavailable here — falling back to the webm quick preview.');
      void this.perform(true); // realtime MediaRecorder path (webm)
      return;
    }
    const blob = await this.exportMp4ToBlob();
    if (blob) deps.recording.downloadClip(URL.createObjectURL(blob), 'avatar-take.mp4');
  };

  /**
   * Render the offline MP4 and return the encoded Blob (no download) — the Studio
   * Bridge uploads it to the MCP sink. Returns null if narration couldn't be built
   * or MP4/WebCodecs is unavailable here. Mirrors exportMp4's framing exactly.
   */
  exportMp4ToBlob = async (): Promise<Blob | null> => {
    const { app, deps } = this;
    if (this.exporting || app.isBusy()) {
      app.log('finish the current take before exporting.');
      return null;
    }
    const prep = await this.prepareForExport();
    if (!prep) return null; // buildNarration already logged why
    const fmt = deps.recording.currentFormat();
    const codec = deps.recording.currentCodec();
    if (!(await canExportMp4(fmt.w, fmt.h))) {
      app.log('MP4/WebCodecs unavailable here — can’t produce an MP4 blob.');
      return null;
    }
    this.exporting = true;
    deps.recording.setExportUi(true);
    app.log(`export: rendering ${prep.durationSec.toFixed(1)}s @ ${fmt.w}×${fmt.h} ${codec.toUpperCase()} …`);
    try {
      // ONE Performance feeds the export — the SAME builder/shape the live narration tick
      // drives. An authored Score Performance (landed via loadPerformance) OWNS the export when
      // present; only a plain generated narration rebuilds from the script segments. Either way
      // the timeline's motion-track cues (turn/point/wave/…) + authored camera framing cues are
      // folded into the (script-derived) Performance (motionCues/cameraCues, mirroring
      // screenWindows); the screen channel carries the montage cut. The two-shot follow snaps
      // EXACTLY on frame 0 (restored) then uses the SAME 1-exp(-dt/0.45) damping as live. The
      // whole drive is one `score.drive(t, dt, mouth)` call.
      const perf =
        this.authoredPerf ??
        buildNarrationPerformance(prep.segs, prep.durationSec, deps.timeline.screenWindows(), undefined, {
          motionCues: deps.timeline.motionCues(),
          cameraCues: deps.timeline.cameraCues(),
          slideCues: deps.timeline.slideCues(),
        });
      this.score.load(perf, this.fallbackEmotion());
      // Preload the wall-slide backdrop images BEFORE the frame loop so each slide renders with
      // its imagery (the frame-stepped export can't wait on an async load mid-loop); a missing
      // image just falls back to the gradient. live == export: the slides drive identically.
      await app.studio.preloadSlideImages(deps.timeline.slideImageUrls());
      deps.timeline.beginNarration(); // take the camera (authored framing cues) for the export loop
      // Mux the Performance's audio beds/SFX into the MP4 alongside the narration. Authored
      // newscasts carry them on perf.audio (threaded through importScore's { audio } channel);
      // script-derived takes have none. Decoded here; any failure surfaces loudly (no retries).
      const audioCues = perf.audio.length ? await audioCuesToClips(perf.audio, app.audio()) : [];
      const blob = await exportMp4Offline({
        stage: app.stage,
        narration: prep.buffer,
        audioCues,
        durationSec: prep.durationSec,
        fps: 30,
        width: fmt.w,
        height: fmt.h,
        codec,
        driveFrame: (t, dt, mouth) => this.score.drive(t, dt, mouth),
        onProgress: (d, n) => deps.recording.setExportProgress(d, n),
      });
      app.log(`export ready · ${prep.durationSec.toFixed(1)}s ${fmt.w}×${fmt.h} mp4`);
      return blob;
    } catch (err) {
      app.log(`export failed: ${String(err)}`);
      return null;
    } finally {
      this.exporting = false;
      deps.recording.setExportUi(false);
      deps.recording.setExportProgress(0, 0);
      // Release the camera back to OrbitControls + clear any screen cut, then rest to idle
      // (the offline loop left the avatar on the last beat's gesture).
      deps.timeline.endPlayback();
      app.avatar.setSilent();
      app.avatar.setTurn(0);
      app.avatar.restToIdle();
    }
  };

  generateNarration = async (): Promise<void> => {
    this.deps.timeline.setGenerateBusy(true);
    try {
      await this.buildNarration();
    } finally {
      this.deps.timeline.setGenerateBusy(false);
    }
  };

  perform = async (record: boolean): Promise<void> => {
    const { app, deps } = this;
    if (this.performing) return;
    this.performing = true;
    this.session.stop();
    if (!this.narrationAudio) {
      if (!(await this.buildNarration())) {
        this.performing = false;
        return;
      }
    }
    const ctx = app.audio();
    await ctx.resume();
    const out = this.narrationAudio!;

    const srcNode = ctx.createBufferSource();
    srcNode.buffer = out;
    const gain = ctx.createGain();
    srcNode.connect(gain);
    gain.connect(ctx.destination);
    if (app.recordDest) gain.connect(app.recordDest);
    const ana = new AudioAnalyserLipsync(ctx, gain, deps.library.lip.smoothing);

    if (record) {
      try {
        deps.recording.start();
      } catch (err) {
        app.log(`record start failed: ${String(err)}`);
        this.performing = false;
        return;
      }
      deps.recording.setRecUi(true);
      app.dom.downloadEl.hidden = true;
    }

    const startAt = ctx.currentTime + 0.12;
    this.renderSrc = srcNode;
    this.render = { ctx, start: startAt, analyser: ana };
    // ONE Performance feeds the live narration tick — the SAME shape the export loads, so the
    // two clocks drive identical camera/gesture/emotion/screen commands (the live/export
    // divergence is closed here). An authored Score Performance owns the take when present;
    // otherwise rebuild from the script segments. Loaded fresh so its one-shot cursors re-arm.
    const perf =
      this.authoredPerf ??
      buildNarrationPerformance(this.narrationSegs, out.length / out.sampleRate, deps.timeline.screenWindows(), undefined, {
        motionCues: deps.timeline.motionCues(),
        cameraCues: deps.timeline.cameraCues(),
        slideCues: deps.timeline.slideCues(),
      });
    this.score.load(perf, this.fallbackEmotion());
    // Preload the wall-slide images so the live take shows imagery identically to the export
    // (live == export). Falls back to the gradient for any not-yet-loaded / failed image.
    await this.app.studio.preloadSlideImages(deps.timeline.slideImageUrls());

    srcNode.onended = async () => {
      this.render = null;
      this.renderSrc = null;
      deps.timeline.endPlayback();
      deps.timeline.stopAudioCues();
      app.avatar.setSilent();
      app.avatar.setGazeTarget(null);
      app.avatar.restToIdle();
      deps.timeline.setUiPlaying(false);
      deps.timeline.setUiPlayhead(0);
      this.performing = false;
      if (record) {
        const { url, filename } = await deps.recording.stop();
        deps.recording.setRecUi(false);
        deps.recording.downloadClip(url, filename);
      } else {
        app.log('narration playback finished.');
      }
    };

    // If anything in the start path throws, reset state so the busy guard can't wedge.
    try {
      deps.timeline.beginNarration(); // take the camera; motion/camera/screen cues flow via score.drive
      deps.timeline.scheduleAudioCues(ctx, startAt); // background-music / SFX clips, mixed + captured
      deps.timeline.setUiPlaying(!record);
      app.log(
        record
          ? `render: recording ${app.stage.captureLabel()} · ${(out.length / out.sampleRate).toFixed(1)}s …`
          : `playing narration · ${(out.length / out.sampleRate).toFixed(1)}s …`,
      );
      srcNode.start(startAt);
    } catch (err) {
      app.log(`perform failed: ${String(err)}`);
      this.render = null;
      this.renderSrc = null;
      deps.timeline.stopAudioCues();
      deps.timeline.endPlayback();
      deps.timeline.setUiPlaying(false);
      if (record) {
        try {
          await deps.recording.stop();
        } catch {
          /* recorder may not have started */
        }
        deps.recording.setRecUi(false);
      }
      this.performing = false;
    }
  };

  /** Stop an in-progress perform() (preview or record) — onended does the cleanup. */
  stop = (): void => {
    try {
      this.renderSrc?.stop();
    } catch {
      /* already stopped */
    }
  };

  /** The emotion to fall back to when a segment authors none (the UI selector). */
  private fallbackEmotion(): EmotionName {
    return this.app.dom.emotionSel.value as EmotionName;
  }

  /**
   * Land an externally-compiled `Performance` (the Phase 5 Score path) on THIS object's
   * `ScoreDrive` — the same single drive path the live narration tick and the offline
   * export consume. `projectStore.importScore`/`applyPerformance` call this after running
   * `@las/protocol`'s `compileScore`, so an authored Score reaches the runtime through the
   * exact frame loop a generated narration uses (camera/gesture/emotion/turn/look/screen).
   * The cursors reset (a fresh take from t=0), so the next preview/export replays it cleanly.
   */
  loadPerformance(perf: Performance): void {
    this.authoredPerf = perf; // owns the next take/export until a script edit invalidates it
    this.score.load(perf, this.fallbackEmotion());
  }

  /** The synced per-frame loop (registered on stage.onFrame). */
  private tick = (dt: number): void => {
    if (this.exporting) return; // offline export drives the avatar; don't double-step
    const { app, deps } = this;
    const { avatar, stage } = app;
    // Idle auto-align ONLY: keep the anchor + screen in shot (presenter beside the screen).
    // During a take (narration render OR live-speak) the camera comes SOLELY from the
    // Performance's follow keyframe via score.drive — so this no longer runs while speaking
    // (the deleted live/export auto-frame asymmetry: both paths now frame from the Performance,
    // on the SAME snap=false follow term, never a second per-frame follow step).
    if (
      deps.transform.isAutoAlign &&
      !deps.timeline.isPreviewing &&
      this.render == null &&
      !this._speaking &&
      !deps.transform.isGizmoOn
    ) {
      stage.frameAnchorScreen(avatar.group.position, SCREEN_STAND_POS, dt);
    }
    deps.timeline.tickCamRec();
    if (deps.timeline.tickPreview(dt)) return;

    if (this.render) {
      const t = this.render.ctx.currentTime - this.render.start;
      if (t >= 0) {
        deps.timeline.setUiPlayhead(t);
        // ONE drive path: live narration and export both call score.drive(t, dt, mouth)
        // on the same loaded Performance. The mouth is the ONLY injected difference
        // (live analyser sample vs the export's precomputed track).
        this.score.drive(t, dt, this.render.analyser.sample());
      } else {
        avatar.update(dt);
      }
      return;
    }
    if (this._speaking) {
      // Live free-text Speak: drive through the SAME score.drive (no second drive path),
      // feeding the live-speak clock + the injected live mouth (analyser, or the boundary
      // estimate before the audio node arrives). The incremental live Performance (built in
      // onSegmentStart) supplies emotion + gesture one-shots.
      this.liveClock += dt;
      const mouth = this.analyser ? this.analyser.sample() : this.boundary.sample(performance.now());
      this.score.drive(this.liveClock, dt, mouth);
    } else {
      avatar.setSilent();
      avatar.setGazeTarget(null);
      avatar.update(dt);
    }
  };

  init(): void {
    const { app, deps } = this;
    const d = app.dom;

    // The timeline preview's clip-player plays a motion-cue clip directly (the timeline
    // rehearsal path is distinct from score.drive; ScoreDrive owns its own talk-clip state).
    deps.timeline.player.setClipPlayer((name) => {
      if (app.avatar.animationClips.length) app.avatar.playClip(name);
    });

    app.stage.onFrame(this.tick);

    d.speakBtn.addEventListener('click', () => {
      this.boundary.setRate(Number(d.rateEl.value));
      this.session.start(d.scriptEl.value);
      this.setSpeakingUi(true);
    });
    d.stopBtn.addEventListener('click', () => {
      this.session.stop();
      this._speaking = false;
      this.analyser = null;
      this.setSpeakingUi(false);
      // Rest to idle so a barge-in stop doesn't freeze the last gesture (wide hands).
      app.avatar.setSilent();
      app.avatar.setTurn(0);
      app.avatar.restToIdle();
      app.log('stopped (barge-in)');
    });
    d.liveEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const line = d.liveEl.value.trim();
        if (!line) return;
        this.boundary.setRate(Number(d.rateEl.value));
        this.session.enqueue(line);
        this.setSpeakingUi(true);
        app.log(`streamed in: "${line}"`);
        d.liveEl.value = '';
      }
    });
    d.rateEl.addEventListener('input', () => this.boundary.setRate(Number(d.rateEl.value)));
    d.scriptEl.addEventListener('input', () => {
      this.narrationAudio = null;
    });
    d.emotionSel.addEventListener('change', () => {
      app.avatar.setEmotion(d.emotionSel.value as EmotionName);
      app.log(`emotion → ${d.emotionSel.value}`);
    });
    app.avatar.setEmotion(d.emotionSel.value as EmotionName);

    d.lipTestBtn.addEventListener('click', () => {
      if (app.isBusy()) {
        app.log('finish the current take before testing lips.');
        return;
      }
      app.audio();
      this.session.start('Lip sync calibration test. Watch how much the lips are moving as I speak.');
      this.setSpeakingUi(true);
    });

    d.recordBtn.addEventListener('click', () => {
      if (this.render) {
        this.stop(); // ends early → onended exports what's captured (if recording)
        return;
      }
      if (deps.recording.active) {
        void deps.recording.stop().then(({ url, filename }) => {
          deps.recording.setRecUi(false);
          deps.recording.downloadClip(url, filename);
        });
        return;
      }
      app.audio();
      if (deps.voices.activeTts.synthesize) {
        void this.perform(true);
      } else {
        try {
          deps.recording.start();
          deps.recording.setRecUi(true);
          d.downloadEl.hidden = true;
          app.log(`recording live ${app.stage.captureLabel()} — press Speak to perform.`);
        } catch (err) {
          app.log(`recording failed to start: ${String(err)}`);
        }
      }
    });

    d.exportMp4Btn.addEventListener('click', () => void this.exportMp4());
  }
}
