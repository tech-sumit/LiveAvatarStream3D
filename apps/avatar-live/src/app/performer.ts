import { BoundaryLipsync } from '../lipsync/boundaryLipsync.js';
import { AudioAnalyserLipsync } from '../lipsync/audioLipsync.js';
import { RealtimeSession } from '../session/realtimeSession.js';
import { resolveGesture, selectTalkClip, type Gesture } from '../avatar/gestures.js';
import { exportMp4Offline } from '../capture/offlineExporter.js';
import { canExportMp4 } from '../capture/mp4Encoder.js';
import { cueId, type Cue } from '../timeline/types.js';
import type { EmotionName } from '../avatar/emotion.js';
import type { MouthCue } from '../avatar/avatarController.js';
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
  timeline: { t: number; gesture: string; emotion?: string }[];
  idx: number;
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
  private lastTalkClip = 'idle';
  private render: RenderState | null = null;
  private renderSrc: AudioBufferSourceNode | null = null;
  private narrationAudio: AudioBuffer | null = null;
  private narrationSegs: { t: number; gesture: string; emotion?: string }[] = [];
  private exporting = false;
  private performing = false; // guards re-entry while synthesizing / playing
  private session: RealtimeSession;

  constructor(
    private app: StudioContext,
    private deps: PerformerDeps,
  ) {
    this.boundary = new BoundaryLipsync(Number(app.dom.rateEl.value));
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
          this._speaking = true;
          const emo = (emotion as EmotionName) ?? (app.dom.emotionSel.value as EmotionName);
          if (emotion) app.avatar.setEmotion(emo);
          if (app.avatar.animationClips.length) {
            this.lastTalkClip = selectTalkClip((gesture as Gesture) ?? 'explain', emo, this.lastTalkClip);
            app.avatar.playClip(this.lastTalkClip);
          }
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
      resolveGesture,
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
    const segs = lines.map(resolveGesture);
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
    const segTimeline: { t: number; gesture: string; emotion?: string }[] = [];
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
    { buffer: AudioBuffer; segs: { t: number; gesture: string; emotion?: string }[]; durationSec: number } | null
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
      const cursor = { idx: -1 };
      const blob = await exportMp4Offline({
        stage: app.stage,
        narration: prep.buffer,
        audioCues: [],
        durationSec: prep.durationSec,
        fps: 30,
        width: fmt.w,
        height: fmt.h,
        codec,
        driveFrame: (t, dt, mouth) => {
          deps.timeline.playerUpdate(t); // camera / motion / screen cuts
          app.stage.seekScreen(t); // keep a back-wall montage in sync with the frame clock
          this.driveAvatarFrame(t, dt, mouth, prep.segs, cursor);
        },
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
      // The offline loop left the avatar on the last beat's gesture — rest to idle.
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
    this.render = { ctx, start: startAt, analyser: ana, timeline: this.narrationSegs, idx: -1 };

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
      deps.timeline.beginPlayback(); // camera (if framing cues) + motion + screen cuts off the clock
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

  /**
   * Per-frame avatar drive shared by the realtime tick and the offline exporter:
   * sets mouth + gaze, advances the narration-segment cursor (emotion + talk clip),
   * and steps the avatar. `cursor.idx` is the last-applied segment index.
   */
  private driveAvatarFrame(
    t: number,
    dt: number,
    mouth: MouthCue,
    segs: { t: number; gesture: string; emotion?: string }[],
    cursor: { idx: number },
  ): void {
    const { app } = this;
    const { avatar, stage } = app;
    avatar.setMouth(mouth);
    avatar.setGazeTarget(stage.cameraWorldPosition());
    while (cursor.idx + 1 < segs.length && segs[cursor.idx + 1].t <= t) {
      cursor.idx++;
      const seg = segs[cursor.idx];
      const emo = (seg.emotion as EmotionName) ?? (app.dom.emotionSel.value as EmotionName);
      avatar.setEmotion(emo);
      if (avatar.animationClips.length) {
        this.lastTalkClip = selectTalkClip(seg.gesture as Gesture, emo, this.lastTalkClip);
        avatar.playClip(this.lastTalkClip);
      }
    }
    avatar.update(dt);
  }

  /** The synced per-frame loop (registered on stage.onFrame). */
  private tick = (dt: number): void => {
    if (this.exporting) return; // offline export drives the avatar; don't double-step
    const { app, deps } = this;
    const { avatar, stage } = app;
    // Auto-align: keep the face centered while the user owns the camera.
    if (deps.transform.isAutoAlign && !deps.timeline.isPreviewing && this.render == null && !deps.transform.isGizmoOn) {
      stage.softAlignToFace(deps.transform.faceWorld());
    }
    deps.timeline.tickCamRec();
    if (deps.timeline.tickPreview(dt)) return;

    if (this.render) {
      const t = this.render.ctx.currentTime - this.render.start;
      if (t >= 0) {
        deps.timeline.setUiPlayhead(t);
        deps.timeline.playerUpdate(t);
        this.driveAvatarFrame(t, dt, this.render.analyser.sample(), this.render.timeline, this.render);
      } else {
        avatar.update(dt);
      }
      return;
    }
    if (this._speaking) {
      avatar.setMouth(this.analyser ? this.analyser.sample() : this.boundary.sample(performance.now()));
    } else {
      avatar.setSilent();
    }
    avatar.setGazeTarget(this._speaking ? stage.cameraWorldPosition() : null);
    avatar.update(dt);
  };

  init(): void {
    const { app, deps } = this;
    const d = app.dom;

    // The timeline's clip-player writes our "current talk clip" + plays it.
    deps.timeline.player.setClipPlayer((name) => {
      if (app.avatar.animationClips.length) {
        this.lastTalkClip = name;
        app.avatar.playClip(name);
      }
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
