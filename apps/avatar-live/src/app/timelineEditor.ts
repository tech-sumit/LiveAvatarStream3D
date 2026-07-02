import { TimelinePlayer } from '../timeline/player.js';
import { TimelineUI } from '../timeline/ui.js';
import { CATALOG, poseToTuple, poseFor, tupleToPose } from '../timeline/catalog.js';
import { cueId, type Cue, type PoseTuple, type Timeline } from '../timeline/types.js';
import type { SlideContent } from '@las/protocol';
import type { StudioContext } from './context.js';
import type { Performer } from './performer.js';

function demoTimeline(): Timeline {
  const c = (track: 'camera' | 'motion', type: string, start: number, duration: number) => ({
    id: cueId(),
    track,
    type,
    start,
    duration,
  });
  return {
    duration: 26,
    cues: [
      c('camera', 'cam.enterLeft', 0, 0.1),
      c('camera', 'cam.anchor', 0.3, 2.6),
      c('camera', 'cam.close', 6, 1.5),
      c('camera', 'cam.screen', 10, 1.8),
      c('motion', 'motion.turnScreen', 10, 1),
      c('motion', 'motion.point', 11, 1.6),
      c('motion', 'motion.faceFront', 16, 1),
      c('camera', 'cam.anchor', 16, 1.8),
      c('camera', 'cam.wide', 22, 2.6),
    ],
  };
}

/** Director timeline: cues, preview, camera capture/record, audio lane, cue inspector. */
export class TimelineEditor {
  readonly timeline: Timeline = demoTimeline();
  readonly player: TimelinePlayer;
  private ui: TimelineUI | null = null;
  private previewStart: number | null = null;
  private playheadT = 0; // where new cues are added
  private camRec: { start: number; buf: { t: number; p: PoseTuple }[]; last: number; at: number } | null = null;
  private selectedCue: Cue | null = null;
  private audioBuffers = new Map<string, AudioBuffer>(); // cue.id → decoded buffer
  private audioBlobs = new Map<string, Blob>(); // cue.id → original bytes (for R2 upload)
  private scheduledAudio: AudioBufferSourceNode[] = [];
  private performer: Performer | null = null; // late-bound (set by main after both exist)

  constructor(private app: StudioContext) {
    this.player = new TimelinePlayer(app.stage, app.avatar);
    this.player.load(this.timeline);
  }

  attachPerformer(p: Performer): void {
    this.performer = p;
  }

  get busy(): boolean {
    return this.previewStart != null;
  }
  get isPreviewing(): boolean {
    return this.previewStart != null;
  }
  get blobs(): Map<string, Blob> {
    return this.audioBlobs;
  }

  // ── per-frame hooks (called from Performer's render loop) ──
  tickCamRec(): void {
    if (!this.camRec) return;
    const rt = performance.now() / 1000 - this.camRec.start;
    if (rt - this.camRec.last >= 1 / 30) {
      this.camRec.last = rt;
      this.camRec.buf.push({ t: rt, p: poseToTuple(this.app.stage.getCameraPose()) });
    }
  }
  /** Returns true if preview drove the avatar this frame (caller should return). */
  tickPreview(dt: number): boolean {
    if (this.previewStart == null) return false;
    const t = performance.now() / 1000 - this.previewStart;
    if (t >= this.timeline.duration) {
      this.stopPreview();
      return false;
    }
    this.playheadT = t;
    this.player.update(t);
    this.ui?.setPlayhead(t);
    this.app.avatar.setSilent();
    this.app.avatar.setGazeTarget(this.app.stage.cameraWorldPosition());
    this.app.avatar.update(dt);
    return true;
  }
  playerUpdate(t: number): void {
    this.player.update(t);
  }
  /**
   * The authored "cut to screen" windows (the `cam.screenSource` cues) as plain
   * {start,duration} — fed into the Performance `screen` channel (Phase 4c) so the
   * back-wall montage cut fires from the unified score.drive path on both the live and
   * export clocks (was player.updateScreenSource interpreting the cue inline).
   */
  screenWindows(): { start: number; duration: number }[] {
    return this.timeline.cues
      .filter((c) => c.type === 'cam.screenSource')
      .map((c) => ({ start: c.start, duration: c.duration }));
  }
  /**
   * The timeline's motion-track cues as {t,type} (mirrors screenWindows()) — folded into the
   * Performance `turns`/`gestures` channels by buildNarrationPerformance so a 'Turn to screen'
   * etc. fires from the unified score.drive path on BOTH the live and export clocks (Phase 4c
   * had dropped these — the avatar never turned to the wall in preview or the MP4).
   */
  motionCues(): { t: number; type: string }[] {
    return this.timeline.cues
      .filter((c) => c.track === 'motion')
      .map((c) => ({ t: c.start, type: c.type }))
      .sort((a, b) => a.t - b.t);
  }
  /**
   * The 'graphics'-track wall slides as {tSec, slide} (mirrors motionCues()) — folded into the
   * Performance `slides` channel by buildNarrationPerformance so the wall slide deck swaps per
   * newscast section from the unified score.drive path on BOTH the live and export clocks.
   */
  slideCues(): { tSec: number; slide: SlideContent }[] {
    return this.timeline.cues
      .filter((c): c is Cue & { slide: SlideContent } => c.track === 'graphics' && !!c.slide)
      .map((c) => ({ tSec: c.start, slide: c.slide }))
      .sort((a, b) => a.tSec - b.tSec);
  }
  /**
   * The slide backdrop image urls referenced by the 'graphics' track (deduped, non-empty) —
   * collected so the studio can preload them before a take/export's frame loop.
   */
  slideImageUrls(): string[] {
    const urls = new Set<string>();
    for (const c of this.timeline.cues) {
      if (c.track === 'graphics' && c.slide?.image) urls.add(c.slide.image);
    }
    return [...urls];
  }
  /**
   * The authored camera-track framing cues (everything except the cam.screenSource cut),
   * resolved to absolute poses against the live avatar head — the SAME resolution
   * TimelinePlayer.resolvePose used (captured pose / recorded-path last key / preset). Folded
   * into the Performance camera channel as follow:false keyframes so the unified drive path
   * honors them (they were silently dropped on live narration after the cutover).
   */
  cameraCues(): { tSec: number; pos: [number, number, number]; target: [number, number, number]; fov: number; roll: number }[] {
    const hc = this.app.avatar.headCenter.clone().add(this.app.avatar.group.position);
    const hh = this.app.avatar.headHeight;
    return this.timeline.cues
      .filter((c) => c.track === 'camera' && c.type !== 'cam.screenSource')
      .sort((a, b) => a.start - b.start)
      .map((c) => {
        const p =
          c.path && c.path.length
            ? tupleToPose(c.path[c.path.length - 1].p)
            : c.pose
              ? tupleToPose(c.pose)
              : poseFor(c.type, hc, hh);
        return {
          tSec: c.start,
          pos: [p.pos.x, p.pos.y, p.pos.z] as [number, number, number],
          target: [p.target.x, p.target.y, p.target.z] as [number, number, number],
          fov: p.fov,
          roll: p.roll ?? 0,
        };
      });
  }
  setUiPlayhead(t: number): void {
    this.ui?.setPlayhead(t);
  }
  setUiPlaying(on: boolean): void {
    this.ui?.setPlaying(on);
  }
  beginPlayback(): void {
    this.player.begin();
  }
  /**
   * Begin a unified narration TAKE (live render / export): take the camera so the score's
   * per-frame framing isn't fought by OrbitControls, WITHOUT firing the timeline's motion /
   * camera / screen cues (those now flow from the compiled Performance via score.drive — firing
   * them here too would double-drive). See TimelinePlayer.beginNarration.
   */
  beginNarration(): void {
    this.player.beginNarration();
  }
  endPlayback(): void {
    this.player.end();
  }

  // ── narration handoff (Performer builds the buffer, we own the cues) ──
  setNarrationCues(cues: Cue[], totalSec: number): void {
    // The narration defines the performance length. Replace narration cues, and drop any
    // camera/motion cues that start AFTER the new narration ends — those are stale (e.g.
    // leftover demo-seed blocks authored for a longer script) and would fire after the
    // performance is over. Cues overlapping the narration window and audio beds are kept,
    // and the duration is allowed to SHRINK to fit, so the timeline tracks the script.
    this.timeline.cues = this.timeline.cues
      .filter((c) => c.track !== 'narration')
      .filter((c) => !((c.track === 'camera' || c.track === 'motion') && c.start >= totalSec))
      .concat(cues);
    const cueEnd = this.timeline.cues.reduce((m, c) => Math.max(m, Math.ceil(c.start + c.duration)), 0);
    this.timeline.duration = Math.max(Math.ceil(totalSec) + 1, cueEnd);
    this.player.load(this.timeline);
    this.ui?.reload();
  }

  private pruneAudioMaps(): void {
    const ids = new Set(this.timeline.cues.filter((c) => c.track === 'audio').map((c) => c.id));
    for (const id of [...this.audioBuffers.keys()]) if (!ids.has(id)) this.audioBuffers.delete(id);
    for (const id of [...this.audioBlobs.keys()]) if (!ids.has(id)) this.audioBlobs.delete(id);
  }

  /**
   * The audio-track cues as offline-mixdown clips, from the SAME decoded buffers the live
   * scheduler plays — so the exported MP4 carries the music/SFX the preview played (the legacy
   * project/newscast path, where perf.audio is empty). Normalization (default volume, fade
   * scaling, duration clamp) mirrors scheduleAudioCues exactly. Cues whose file was never
   * loaded this session surface loudly instead of silently missing from the MP4.
   */
  exportAudioClips(): { buffer: AudioBuffer; start: number; volume: number; fadeIn: number; fadeOut: number; durationSec: number }[] {
    const clips: { buffer: AudioBuffer; start: number; volume: number; fadeIn: number; fadeOut: number; durationSec: number }[] = [];
    for (const c of this.timeline.cues) {
      if (c.track !== 'audio') continue;
      const buf = this.audioBuffers.get(c.id);
      if (!buf) {
        this.app.log(`export: audio cue "${c.label ?? c.src ?? c.id}" has no loaded file — it will be missing from the MP4.`);
        continue;
      }
      const len = Math.min(buf.duration, c.duration);
      let fi = Math.max(0, c.fadeIn ?? 0);
      let fo = Math.max(0, c.fadeOut ?? 1);
      if (fi + fo > len && fi + fo > 0) {
        const s = len / (fi + fo);
        fi *= s;
        fo *= s;
      }
      clips.push({ buffer: buf, start: c.start, volume: c.volume ?? 0.8, fadeIn: fi, fadeOut: fo, durationSec: len });
    }
    return clips;
  }

  /**
   * Clean-slate cue import for a bridge apply_newscast/patch_newscast: REPLACES the whole cue
   * set (not setNarrationCues' merge, which keeps existing audio/graphics cues — correct for a
   * live TTS re-take, but on a repeated bridge import it accumulated duplicate audio beds and
   * kept the previous project's stale graphics/camera cues).
   */
  importCues(cues: Cue[], totalSec: number): void {
    this.timeline.cues = [...cues];
    const cueEnd = this.timeline.cues.reduce((m, c) => Math.max(m, Math.ceil(c.start + c.duration)), 0);
    this.timeline.duration = Math.max(Math.ceil(totalSec) + 1, cueEnd);
    this.pruneAudioMaps();
    this.player.load(this.timeline);
    this.ui?.reload();
  }

  /**
   * Replace ONE track's cues (others untouched). Used by the authored-Score narration build to
   * re-lay the audio/graphics tracks on the real TTS clock after recompiling — audio cue ids are
   * stable (doc-authored), so their decoded buffers survive the prune and the live scheduler
   * plays the re-timed cues without a re-fetch.
   */
  replaceTrackCues(track: Cue['track'], cues: Cue[]): void {
    this.timeline.cues = this.timeline.cues.filter((c) => c.track !== track).concat(cues);
    const cueEnd = this.timeline.cues.reduce((m, c) => Math.max(m, Math.ceil(c.start + c.duration)), 0);
    this.timeline.duration = Math.max(this.timeline.duration, cueEnd);
    this.pruneAudioMaps();
    this.player.load(this.timeline);
    this.ui?.reload();
  }

  scheduleAudioCues(ctx: AudioContext, startAt: number): void {
    for (const c of this.timeline.cues) {
      if (c.track !== 'audio') continue;
      const buf = this.audioBuffers.get(c.id);
      if (!buf) continue; // file not loaded this session (e.g. after a reload)
      const vol = c.volume ?? 0.8;
      const len = Math.min(buf.duration, c.duration);
      const t0 = startAt + c.start;
      const tEnd = t0 + len;
      let fi = Math.max(0, c.fadeIn ?? 0);
      let fo = Math.max(0, c.fadeOut ?? 1);
      if (fi + fo > len && fi + fo > 0) {
        const s = len / (fi + fo);
        fi *= s;
        fo *= s;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      src.connect(gain);
      gain.connect(ctx.destination);
      if (this.app.recordDest) gain.connect(this.app.recordDest);
      const g = gain.gain;
      g.setValueAtTime(fi > 0 ? 0.0001 : vol, t0);
      if (fi > 0) g.linearRampToValueAtTime(vol, t0 + fi);
      if (fo > 0) {
        g.setValueAtTime(vol, tEnd - fo);
        g.linearRampToValueAtTime(0.0001, tEnd);
      }
      src.start(t0, 0, len);
      this.scheduledAudio.push(src);
    }
  }
  stopAudioCues(): void {
    for (const s of this.scheduledAudio) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.scheduledAudio = [];
  }

  // ── preview controls ──
  private startPreview(): void {
    if (this.previewStart != null) return;
    this.player.begin();
    this.previewStart = performance.now() / 1000;
    this.ui?.setPlaying(true);
  }
  stopPreview = (): void => {
    if (this.previewStart == null) return;
    this.previewStart = null;
    this.player.end();
    this.ui?.setPlaying(false);
    this.ui?.setPlayhead(0);
  };
  private togglePreview = (): void => {
    const p = this.performer;
    if (!p) return;
    if (p.isRendering) {
      p.stop(); // narration playback in progress → stop
      return;
    }
    if (this.previewStart != null) {
      this.stopPreview();
      return;
    }
    // If narration is generated, Preview plays it lip-synced; otherwise it's a
    // silent camera/motion rehearsal.
    if (p.hasNarration) void p.perform(false);
    else this.startPreview();
  };
  private seekPreview = (t: number): void => {
    if (this.previewStart == null) this.startPreview();
    this.previewStart = performance.now() / 1000 - t;
    this.playheadT = t;
  };

  private captureCameraCue = (): void => {
    this.timeline.cues.push({
      id: cueId(),
      track: 'camera',
      type: 'cam.custom',
      start: Math.round(this.playheadT * 10) / 10,
      duration: 1.5,
      pose: poseToTuple(this.app.stage.getCameraPose()),
    });
    this.player.load(this.timeline);
    this.ui?.refresh();
    this.app.log(`captured camera view as a cue @ ${this.playheadT.toFixed(1)}s.`);
  };
  private toggleCameraRecord = (): void => {
    if (this.camRec) {
      const buf = this.camRec.buf;
      const at = this.camRec.at;
      const dur = buf.length ? buf[buf.length - 1].t : 0;
      this.camRec = null;
      this.ui?.setRecording(false);
      if (buf.length > 1) {
        this.timeline.cues.push({ id: cueId(), track: 'camera', type: 'cam.path', start: at, duration: dur, path: buf });
        this.player.load(this.timeline);
        this.ui?.refresh();
        this.app.log(`recorded camera move (${dur.toFixed(1)}s) @ ${at.toFixed(1)}s.`);
      } else {
        this.app.log('camera recording too short.');
      }
    } else {
      this.stopPreview();
      this.camRec = { start: performance.now() / 1000, buf: [], last: -1, at: Math.round(this.playheadT * 10) / 10 };
      this.ui?.setRecording(true);
      this.app.log('recording camera — orbit / scroll / arrow keys to move, then Stop rec.');
    }
  };

  private addAudioClip = (): void => {
    this.app.dom.audioFileEl.click();
  };

  private showCueInspector = (cue: Cue | null): void => {
    const d = this.app.dom;
    this.selectedCue = cue;
    d.cueInspectorEl.hidden = !cue;
    if (!cue) return;
    const name = cue.track === 'audio' ? (cue.label ?? 'audio') : cue.track === 'narration' ? (cue.text ?? '') : CATALOG[cue.type]?.label ?? cue.type;
    d.cueTypeEl.textContent = `${cue.track} · ${name}`;
    d.cueStartEl.value = cue.start.toFixed(1);
    d.cueDurEl.value = cue.duration.toFixed(1);
    const ro = cue.track === 'narration';
    d.cueStartEl.disabled = ro;
    d.cueDurEl.disabled = ro;
    d.cueSetViewBtn.hidden = cue.track !== 'camera' || !!cue.path || cue.type === 'cam.screenSource';
    d.cueAudioEl.hidden = cue.track !== 'audio';
    if (cue.track === 'audio') {
      d.cueVolEl.value = String(cue.volume ?? 0.8);
      d.cueFadeInEl.value = String(cue.fadeIn ?? 0);
      d.cueFadeOutEl.value = String(cue.fadeOut ?? 1);
    }
  };

  buildUI = (): void => {
    if (this.ui) return;
    this.ui = new TimelineUI(this.app.dom.timelineEl, this.timeline, {
      onChange: () => {
        this.player.load(this.timeline);
        this.pruneAudioMaps();
      },
      onPreview: this.togglePreview,
      onStop: this.stopPreview,
      onSeek: this.seekPreview,
      onCapturePose: this.captureCameraCue,
      onRecordPath: this.toggleCameraRecord,
      onSelect: this.showCueInspector,
      onGenerate: () => void this.performer?.generateNarration(),
      onAddAudio: this.addAudioClip,
    });
  };

  /** Enable/disable the timeline's own Generate button (created by TimelineUI). */
  setGenerateBusy(on: boolean): void {
    const gen = document.getElementById('tlGen') as HTMLButtonElement | null;
    if (gen) gen.disabled = on;
  }

  serialize(): { timeline: { duration: number; cues: Cue[] } } {
    return { timeline: { duration: this.timeline.duration, cues: this.timeline.cues } };
  }

  // ── Programmatic cue API (used by the Studio Bridge) ──────────────────────
  /** The current cue list (read-only snapshot). */
  listCues(): Cue[] {
    return this.timeline.cues.map((c) => ({ ...c }));
  }
  /** Add a cue on a track; returns its generated id. */
  addCue(track: Cue['track'], type: string, start: number, duration?: number): string {
    const id = cueId();
    const dur = Math.max(0.1, duration ?? CATALOG[type]?.defaultDuration ?? 1.5);
    this.timeline.cues.push({ id, track, type, start: Math.max(0, start), duration: dur });
    this.timeline.duration = Math.max(this.timeline.duration, Math.ceil(start + dur) + 1);
    this.player.load(this.timeline);
    this.buildUI();
    this.ui?.reload();
    return id;
  }
  /** Update an existing cue's timing. Returns false if not found. */
  updateCue(id: string, patch: { start?: number; duration?: number }): boolean {
    const cue = this.timeline.cues.find((c) => c.id === id);
    if (!cue) return false;
    if (patch.start != null) cue.start = Math.max(0, patch.start);
    if (patch.duration != null) cue.duration = Math.max(0.1, patch.duration);
    this.player.load(this.timeline);
    this.ui?.refresh();
    return true;
  }
  /** Remove a cue by id. Returns false if not found. */
  removeCue(id: string): boolean {
    const before = this.timeline.cues.length;
    this.timeline.cues = this.timeline.cues.filter((c) => c.id !== id);
    if (this.timeline.cues.length === before) return false;
    if (this.selectedCue?.id === id) this.selectedCue = null;
    this.player.load(this.timeline);
    this.ui?.reload();
    return true;
  }
  /** Set the overall timeline length (seconds). */
  setTimelineLength(seconds: number): void {
    this.timeline.duration = Math.max(2, Math.round(seconds));
    this.player.load(this.timeline);
    this.buildUI();
    this.ui?.reload();
  }
  /** Remove every cue. */
  clearTimeline(): void {
    this.timeline.cues = [];
    this.selectedCue = null;
    this.player.load(this.timeline);
    this.buildUI();
    this.ui?.reload();
  }
  /** Capture the live camera view as a Custom-view camera cue; returns its id. */
  captureView(label?: string): string {
    const id = cueId();
    this.timeline.cues.push({
      id,
      track: 'camera',
      type: 'cam.custom',
      start: Math.round(this.playheadT * 10) / 10,
      duration: 1.5,
      pose: poseToTuple(this.app.stage.getCameraPose()),
      ...(label ? { label } : {}),
    });
    this.player.load(this.timeline);
    this.buildUI();
    this.ui?.reload();
    return id;
  }
  /** Start (or restart) the timeline preview programmatically. */
  startPreviewPublic(): void {
    const p = this.performer;
    if (p?.hasNarration) void p.perform(false);
    else this.startPreview();
  }
  applyTimelineDoc(data: { duration?: number; cues?: Cue[] } | null | undefined): void {
    const cues = Array.isArray(data?.cues) ? data.cues : [];
    this.timeline.duration = Math.max(2, Number(data?.duration) || 26);
    this.timeline.cues = cues.map((c) => ({ ...c, id: cueId() }));
    this.player.load(this.timeline);
    this.pruneAudioMaps();
    this.buildUI();
    this.ui?.reload();
    const appEl = this.app.dom.appEl;
    if (!appEl.classList.contains('tl-open')) {
      appEl.classList.add('tl-open');
      this.app.dom.timelineToggle.classList.add('primary');
    }
  }
  /** Re-fetch + decode audio assets after a project load (cue ids already regenerated). */
  async loadAudioAssets(fetchBlob: (src: string) => Promise<Blob>): Promise<void> {
    await Promise.all(
      this.timeline.cues
        .filter((c) => c.track === 'audio' && c.src)
        .map(async (c) => {
          try {
            const blob = await fetchBlob(c.src!);
            this.audioBlobs.set(c.id, blob);
            this.audioBuffers.set(c.id, await this.app.audio().decodeAudioData(await blob.arrayBuffer()));
          } catch {
            this.app.log(`audio asset missing: ${c.src}`);
          }
        }),
    );
  }

  init(): void {
    const d = this.app.dom;
    d.timelineToggle.addEventListener('click', () => {
      const open = d.appEl.classList.toggle('tl-open'); // grid row expands; Stage's ResizeObserver resizes
      if (open) this.buildUI();
      d.timelineToggle.classList.toggle('primary', open);
      if (!open) this.stopPreview();
    });

    d.audioFileEl.addEventListener('change', async () => {
      const file = d.audioFileEl.files?.[0];
      d.audioFileEl.value = '';
      if (!file) return;
      try {
        const ctx = this.app.audio();
        const buf = await ctx.decodeAudioData(await file.arrayBuffer());
        const id = cueId();
        this.audioBuffers.set(id, buf);
        this.audioBlobs.set(id, file);
        const start = Math.round(this.playheadT * 10) / 10;
        const duration = Math.round(buf.duration * 10) / 10;
        this.timeline.cues.push({
          id,
          track: 'audio',
          type: 'audio.clip',
          start,
          duration,
          label: file.name.replace(/\.[^.]+$/, ''),
          volume: 0.8,
          fadeIn: 0,
          fadeOut: 1.0,
        });
        this.timeline.duration = Math.max(this.timeline.duration, Math.ceil(start + duration) + 1);
        this.player.load(this.timeline);
        this.ui?.reload();
        this.app.log(`added audio "${file.name}" (${buf.duration.toFixed(1)}s) @ ${this.playheadT.toFixed(1)}s.`);
      } catch (err) {
        this.app.log(`couldn't load audio: ${String(err)}`);
      }
    });

    // Arrow-key camera navigation (when the director isn't driving the camera).
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (this.previewStart != null || this.performer?.isRendering) return; // director owns the camera
      // A selected (editable) cue claims ←/→ for nudging (TimelineUI handles it).
      if (this.selectedCue && this.selectedCue.track !== 'narration' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      const s = e.shiftKey ? 0.25 : 0.08;
      switch (e.key) {
        case 'ArrowLeft': this.app.stage.nudgeCamera(-s, 0, 0); break;
        case 'ArrowRight': this.app.stage.nudgeCamera(s, 0, 0); break;
        case 'ArrowUp': this.app.stage.nudgeCamera(0, 0, s); break; // dolly in
        case 'ArrowDown': this.app.stage.nudgeCamera(0, 0, -s); break; // dolly out
        case 'PageUp': this.app.stage.nudgeCamera(0, s, 0); break; // pedestal up
        case 'PageDown': this.app.stage.nudgeCamera(0, -s, 0); break;
        default:
          return;
      }
      e.preventDefault();
    });

    // Cue inspector edits.
    const commitCueEdit = (): void => {
      if (!this.selectedCue || this.selectedCue.track === 'narration') return; // narration is read-only
      this.selectedCue.start = Math.max(0, Number(d.cueStartEl.value) || 0);
      this.selectedCue.duration = Math.max(0.1, Number(d.cueDurEl.value) || 0.1);
      this.player.load(this.timeline);
      this.ui?.refresh();
    };
    d.cueStartEl.addEventListener('input', commitCueEdit);
    d.cueDurEl.addEventListener('input', commitCueEdit);
    const commitAudioEdit = (): void => {
      if (!this.selectedCue || this.selectedCue.track !== 'audio') return;
      this.selectedCue.volume = Math.max(0, Math.min(1, Number(d.cueVolEl.value)));
      this.selectedCue.fadeIn = Math.max(0, Number(d.cueFadeInEl.value) || 0);
      this.selectedCue.fadeOut = Math.max(0, Number(d.cueFadeOutEl.value) || 0);
    };
    [d.cueVolEl, d.cueFadeInEl, d.cueFadeOutEl].forEach((el) => el.addEventListener('input', commitAudioEdit));
    d.cueSetViewBtn.addEventListener('click', () => {
      if (!this.selectedCue || this.selectedCue.track !== 'camera' || this.selectedCue.type === 'cam.screenSource') return;
      this.selectedCue.pose = poseToTuple(this.app.stage.getCameraPose());
      this.selectedCue.type = 'cam.custom';
      this.player.load(this.timeline);
      this.ui?.refresh();
      this.showCueInspector(this.selectedCue);
      this.app.log('cue set to the current camera view.');
    });
    d.cueDeleteBtn.addEventListener('click', () => {
      if (this.selectedCue) this.ui?.removeCue(this.selectedCue.id);
    });
  }
}
