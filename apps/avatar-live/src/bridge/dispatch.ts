// Studio Bridge command dispatch.
//
// Maps every BridgeCommand (the contract in @las/protocol's bridge.ts) onto the
// already-constructed avatar-live controllers. We PREFER the typed controllers
// passed in from main.ts over DOM pokes or eval; we only touch the DOM where the
// UI itself does (e.g. a <select> whose change-handler owns the side effect).
//
// This module is self-contained and only imported when the bridge is enabled, so
// it never runs in the default (bridge-off) studio.
import { validateNewsReportDoc, validateScore, compileNewsReport, compileNewsReportToScore, newsReportChrome } from '@las/protocol';
import type { Stage, AudioTimings, Score, NewsReportDoc, AudioCue, SlideContent } from '@las/protocol';
import { SCREEN_STAND_POS } from '../scene/studio.js';
import { r2Url, resolveAssetUrl } from '../storage/r2.js';
import { cueId } from '../timeline/types.js';
import type { StudioContext } from '../app/context.js';
import type { Lighting } from '../app/lighting.js';
import type { Look } from '../app/look.js';
import type { Recording } from '../app/recording.js';
import type { BackScreen } from '../app/backScreen.js';
import type { VoicePicker } from '../app/voicePicker.js';
import type { AvatarLibrary } from '../app/avatarLibrary.js';
import type { TimelineEditor } from '../app/timelineEditor.js';
import type { Performer } from '../app/performer.js';
import type { ProjectStore } from '../app/projectStore.js';
import type { AvatarTransform } from '../app/avatarTransform.js';
import type { Cue } from '../timeline/types.js';

/** The controllers main.ts constructs, handed to the bridge. */
export interface BridgeControllers {
  lighting: Lighting;
  look: Look;
  recording: Recording;
  backScreen: BackScreen;
  transform: AvatarTransform;
  voices: VoicePicker;
  library: AvatarLibrary;
  timeline: TimelineEditor;
  performer: Performer;
  projects: ProjectStore;
}

/** Where a screenshot/export blob is POSTed so the MCP server can read it back. */
const SINK_BASE = 'http://127.0.0.1:9778/upload';

/** Capture-format <select> option index per bridge resolution preset. */
const RESOLUTION_INDEX: Record<string, number> = {
  '1080p': 0,
  '4k': 2,
  '720p': 3,
  vertical: 4,
  square: 5,
};

/** Bridge cue tracks → the studio's real TrackKind. */
function mapTrack(track: string): Cue['track'] | null {
  switch (track) {
    case 'camera':
      return 'camera';
    case 'audio':
      return 'audio';
    case 'gesture':
    case 'emotion':
    case 'event':
      // The studio models gestures/emotion/events as motion cues.
      return 'motion';
    default:
      return null;
  }
}

// The studio has no Stage-authoring surface yet (Phase 5), so a newscast Score lands on a
// default Stage matching the live set: the presenter at the origin + a `screen` target at
// the back-wall stand. Scores reference these ids; any unknown ref falls back to the body
// root in compileScore (deterministic, never throws), so this default is always sufficient.
function defaultStage(stageId: string): Stage {
  return {
    id: stageId,
    marks: [{ id: 'center', pos: [0, 0, 0] }],
    targets: [{ id: 'screen', kind: 'point', pos: [SCREEN_STAND_POS.x, SCREEN_STAND_POS.y, SCREEN_STAND_POS.z] }],
    cameras: [],
    lights: [],
    props: [],
    savedShots: [],
  };
}

// Derive per-word AudioTimings from a Score before real TTS timing exists: lay each beat's
// text out evenly across a fixed per-beat window so WordAnchor cues (`at: { word }`) resolve
// to a deterministic time. compileScore clamps an out-of-range anchor, so a coarse layout is
// safe — it only sets WHEN a mid-beat cue fires, not the rendered audio.
function timingsFromScore(score: Score): AudioTimings {
  const BEAT_SEC = 3;
  const beats: AudioTimings['beats'] = [];
  for (let i = 0; i < score.beats.length; i++) {
    const beat = score.beats[i];
    if (!beat) continue;
    const startSec = i * BEAT_SEC;
    const endSec = startSec + BEAT_SEC;
    const words = beat.text.split(/\s+/).filter(Boolean);
    const n = Math.max(words.length, 1);
    const wordTimings = words.map((word, w) => ({
      word,
      startSec: startSec + (w / n) * BEAT_SEC,
      endSec: startSec + ((w + 1) / n) * BEAT_SEC,
    }));
    beats.push({ startSec, endSec, words: wordTimings });
  }
  return { beats };
}

async function blobFromCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))), 'image/png');
  });
}

/**
 * Render a screenshot PNG of the viewport or the output frame (optionally after seeking),
 * returning the raw blob + pixel dims. Shared by the WS bridge (which then uploads it to the
 * HTTP sink) and the in-page WebMCP server (which returns it inline) — so the capture logic
 * lives in one place.
 */
export async function screenshotBlob(
  app: StudioContext,
  c: BridgeControllers,
  params: { target?: unknown; seek?: unknown },
): Promise<{ blob: Blob; width: number; height: number }> {
  if (typeof params.seek === 'number') seekTimeline(c, params.seek);
  // Default to `output`: it renders an on-demand frame, so it works in a hidden/headless tab.
  // `viewport` reads the live preview canvas, whose rAF loop is paused when the tab is hidden,
  // so it can be a stale/black frame under automation.
  const target = params.target == null ? 'output' : String(params.target);
  const canvas =
    target === 'viewport' ? (app.dom.stageEl.querySelector('canvas') as HTMLCanvasElement | null) : app.stage.renderOutputFrame();
  if (!canvas) throw new Error('no canvas to capture');
  const blob = await blobFromCanvas(canvas);
  return { blob, width: canvas.width, height: canvas.height };
}

/** Render the performance to an MP4 blob (throws if the export produced nothing). Shared by
 *  the WS bridge (uploads to sink) and the WebMCP server (downloads in-page). */
export async function exportBlob(c: BridgeControllers): Promise<Blob> {
  const blob = await c.performer.exportMp4ToBlob();
  if (!blob) {
    // exportMp4ToBlob returns null for several reasons (a take/preview already running, WebCodecs
    // unavailable, narration build failed), logging the specific cause to the in-page log. Give
    // the caller the actionable hint rather than a bare "no output".
    throw new Error(
      'export produced no output — if a take or preview is still running, wait for it to finish and retry; otherwise WebCodecs may be unavailable in this browser (see the studio log for the specific cause)',
    );
  }
  return blob;
}

/** POST a binary result to the MCP HTTP sink; returns the saved ref descriptor. */
async function uploadBlob(kind: 'png' | 'mp4', id: string, blob: Blob): Promise<{ ref: string; bytes: number }> {
  const ref = `${kind}/${id}`;
  const r = await fetch(`${SINK_BASE}/${ref}`, {
    method: 'POST',
    headers: { 'content-type': blob.type || (kind === 'png' ? 'image/png' : 'video/mp4') },
    body: blob,
  });
  if (!r.ok) throw new Error(`sink upload failed (${r.status})`);
  return { ref, bytes: blob.size };
}

/**
 * Build the command dispatcher bound to a studio. `dispatch(cmd, params)` returns
 * a JSON-serializable result (or throws — the WS client catches → ok:false).
 */
export function createDispatcher(app: StudioContext, c: BridgeControllers) {
  const d = app.dom;
  // Last-applied newscast doc, scoped to THIS dispatcher (one per transport). Module-global
  // state here would let a patch_newscast on one transport (WS bridge) merge over a doc applied
  // on another (WebMCP), importing a hybrid the caller never authored.
  let lastNewscast: unknown = null;

  /** Fire the native change/input handler the UI relies on after a programmatic set. */
  const fire = (el: HTMLElement, type: 'input' | 'change') => el.dispatchEvent(new Event(type, { bubbles: true }));

  return async function dispatch(cmd: string, params: Record<string, unknown>): Promise<unknown> {
    switch (cmd) {
      // ── Newscast import / validate / patch ─────────────────────────────────
      // A newscast `doc` is a Score (preferred) OR a legacy NewsReportDoc, which is
      // auto-lowered through compileNewsReportToScore. BOTH flow through the SAME Score
      // runtime (projectStore.importScore → compileScore → the Performer's ScoreDrive),
      // so the proven old path is no longer a parallel compileNewsReport/applyProject.
      case 'applyNewscast': {
        const out = await applyScoreDoc(app, c, params.doc);
        lastNewscast = params.doc;
        return { applied: true, ...out };
      }
      case 'validateNewscast': {
        // Validate-only: try Score, then auto-lower NewsReportDoc. Never lands a Performance.
        try {
          validateScore(params.doc);
          return { valid: true, kind: 'score' };
        } catch (scoreErr) {
          try {
            const doc = validateNewsReportDoc(params.doc);
            compileNewsReportToScore(doc); // prove it lowers to a Score
            // (The former loss warnings are gone: apply_newscast now carries the full chrome —
            // avatar, look/lights, wall slides, backScreen, rate/pitch, camera presets — via
            // the same compileNewsReport lowering the file import uses.)
            return { valid: true, kind: 'newsreport', title: doc.meta.title };
          } catch (newsErr) {
            // Report the error from the branch that matched the input shape: a near-valid
            // NewsReportDoc fails NewsReportDoc validation with a useful field-level message —
            // surface THAT, not the generic "not a Score" error. Fall back to the Score error.
            const err = newsErr ?? scoreErr;
            return { valid: false, error: String(err instanceof Error ? err.message : err) };
          }
        }
      }
      case 'patchNewscast': {
        // Deep-merge the patch over the last-applied doc and re-import through the Score
        // runtime. Deep (not shallow): a shallow spread deleted the SIBLINGS of any patched
        // nested object — e.g. patching {defaults:{music:…}} silently wiped defaults.emotion.
        const base = (lastNewscast ?? {}) as Record<string, unknown>;
        const patch = (params.patch ?? {}) as Record<string, unknown>;
        const merged = deepMerge(base, patch) as Record<string, unknown>;
        const out = await applyScoreDoc(app, c, merged);
        lastNewscast = merged;
        return { applied: true, ...out };
      }

      // ── Scalar setters (mirror the UI's own change side effects) ───────────
      case 'setScript': {
        d.scriptEl.value = String(params.script ?? '');
        fire(d.scriptEl, 'input');
        return { ok: true };
      }
      case 'setVoice': {
        const voiceId = String(params.voiceId);
        if ([...d.voiceSel.options].some((o) => o.value === voiceId)) d.voiceSel.value = voiceId;
        if (params.rate != null) {
          d.rateEl.value = String(params.rate);
          fire(d.rateEl, 'input');
        }
        if (params.pitch != null) {
          d.pitchEl.value = String(params.pitch);
          fire(d.pitchEl, 'input');
        }
        fire(d.voiceSel, 'change');
        return { voiceId: d.voiceSel.value };
      }
      case 'setAvatar': {
        const ref = String(params.avatar);
        // loadById for a discovered id; else treat it as a URL.
        const ok = (await c.library.loadById(ref)) || (await c.library.loadAdHoc(ref, ref.split('/').pop() || 'avatar'));
        if (ok) d.avatarSel.value = c.library.currentId ?? d.avatarSel.value;
        return { ok };
      }
      case 'setEmotion': {
        d.emotionSel.value = String(params.emotion);
        fire(d.emotionSel, 'change');
        return { emotion: d.emotionSel.value };
      }
      case 'setLighting': {
        if (typeof params.preset === 'string') {
          d.lightPresetSel.value = params.preset;
          fire(d.lightPresetSel, 'change');
        }
        const map: Record<string, HTMLInputElement> = {
          key: d.lightKey,
          fill: d.lightFill,
          rim: d.lightRim,
          ambient: d.lightAmbient,
          exposure: d.exposureEl,
          warmth: d.warmthEl,
        };
        for (const [k, el] of Object.entries(map)) {
          if (params[k] != null) {
            el.value = String(params[k]);
            fire(el, 'input');
          }
        }
        return { ok: true };
      }
      case 'setLook': {
        if (typeof params.preset === 'string') {
          d.lookPresetSel.value = params.preset;
          fire(d.lookPresetSel, 'change');
        }
        const map: Record<string, HTMLInputElement> = {
          bloom: d.lookBloomEl,
          contrast: d.lookContrastEl,
          saturation: d.lookSaturationEl,
          vignette: d.lookVignetteEl,
          grain: d.lookGrainEl,
        };
        for (const [k, el] of Object.entries(map)) {
          if (params[k] != null) {
            el.value = String(params[k]);
            fire(el, 'input');
          }
        }
        return { ok: true };
      }
      case 'setCaptureFormat': {
        const idx = RESOLUTION_INDEX[String(params.resolution)] ?? 0;
        d.captureFormatSel.value = String(idx);
        fire(d.captureFormatSel, 'change');
        if (typeof params.codec === 'string') {
          // 'avc' / 'hevc' map straight onto the codec <select> values.
          d.videoCodecSel.value = params.codec;
          fire(d.videoCodecSel, 'change');
        }
        return { resolution: params.resolution, codec: d.videoCodecSel.value };
      }

      // ── Timeline cues ──────────────────────────────────────────────────────
      case 'addCue': {
        const track = mapTrack(String(params.track));
        if (!track) throw new Error(`unsupported cue track: ${String(params.track)}`);
        const id = c.timeline.addCue(track, String(params.type), Number(params.start), params.duration != null ? Number(params.duration) : undefined);
        return { id };
      }
      case 'updateCue': {
        const ok = c.timeline.updateCue(String(params.id), {
          start: params.start != null ? Number(params.start) : undefined,
          duration: params.duration != null ? Number(params.duration) : undefined,
        });
        return { ok };
      }
      case 'removeCue': {
        return { ok: c.timeline.removeCue(String(params.id)) };
      }
      case 'listCues': {
        return { cues: c.timeline.listCues() };
      }
      case 'captureView': {
        const id = c.timeline.captureView(typeof params.label === 'string' ? params.label : undefined);
        return { id };
      }
      case 'setTimelineLength': {
        c.timeline.setTimelineLength(Number(params.seconds));
        return { ok: true };
      }
      case 'clearTimeline': {
        c.timeline.clearTimeline();
        return { ok: true };
      }

      // ── Studio dressing ────────────────────────────────────────────────────
      case 'setHeadline': {
        const text = String(params.text ?? '');
        d.headlineInput.value = text;
        fire(d.headlineInput, 'input');
        return { ok: true };
      }
      case 'setBackscreenMedia': {
        if (params.clear === true) {
          c.backScreen.revertScreen();
          return { cleared: true };
        }
        const url = String(params.url);
        await c.backScreen.loadWallVideo(url, url.split('/').pop() || 'video');
        return { url };
      }

      // ── State / capture / render ───────────────────────────────────────────
      case 'getState':
        return snapshotState(app, c);

      case 'screenshot': {
        const { blob, width, height } = await screenshotBlob(app, c, params);
        const saved = await uploadBlob('png', currentReqId(), blob);
        return { ...saved, width, height };
      }

      case 'preview': {
        c.timeline.startPreviewPublic();
        return { started: true };
      }

      case 'exportMp4': {
        const saved = await uploadBlob('mp4', currentReqId(), await exportBlob(c));
        return saved;
      }

      // ── Escape hatch ───────────────────────────────────────────────────────
      case 'executeJs': {
        const code = String(params.code ?? '');
        const las = (window as unknown as { __las?: unknown }).__las;
        const fn = new Function('__las', 'app', 'controllers', `"use strict";\nreturn (async () => { ${code} })();`);
        const out = await fn(las, app, c);
        return out === undefined ? null : JSON.parse(JSON.stringify(out));
      }

      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  };

  // ── helpers closed over the dispatcher ──
  function snapshotState(app: StudioContext, c: BridgeControllers) {
    const d = app.dom;
    return {
      script: d.scriptEl.value,
      voiceId: d.voiceSel.value,
      rate: Number(d.rateEl.value),
      pitch: Number(d.pitchEl.value),
      avatar: c.library.currentId,
      emotion: d.emotionSel.value,
      lighting: {
        preset: d.lightPresetSel.value,
        key: Number(d.lightKey.value),
        fill: Number(d.lightFill.value),
        rim: Number(d.lightRim.value),
        ambient: Number(d.lightAmbient.value),
        exposure: Number(d.exposureEl.value),
        warmth: Number(d.warmthEl.value),
      },
      look: {
        preset: d.lookPresetSel.value,
        bloom: Number(d.lookBloomEl.value),
        contrast: Number(d.lookContrastEl.value),
        saturation: Number(d.lookSaturationEl.value),
        vignette: Number(d.lookVignetteEl.value),
        grain: Number(d.lookGrainEl.value),
      },
      captureFormat: { resolution: d.captureFormatSel.value, codec: d.videoCodecSel.value },
      cues: c.timeline.listCues(),
      timelineLength: c.timeline.timeline.duration,
      headline: d.headlineInput.value,
      busy: app.isBusy(),
      idle: !app.isBusy(),
      avatarCatalog: [...d.avatarSel.options].map((o) => ({ id: o.value, label: o.textContent })),
      voiceCatalog: [...d.voiceSel.options].map((o) => ({ id: o.value, label: o.textContent })),
    };
  }
}

// The active request id, set by the WS client per inbound request so screenshot /
// export uploads can name their sink ref after the correlation id.
let activeReqId = '';
export function setActiveReqId(id: string): void {
  activeReqId = id;
}
function currentReqId(): string {
  return activeReqId || `req_${Date.now()}`;
}

function seekTimeline(c: BridgeControllers, seconds: number): void {
  // Drive a single output frame at `seconds` via the timeline player.
  c.timeline.playerUpdate(Math.max(0, seconds));
}

/**
 * Land a newscast `doc` on the Score runtime: try {@link validateScore} → importScore;
 * on failure auto-lower a legacy NewsReportDoc through {@link compileNewsReportToScore} →
 * importScore. Both paths compile against a {@link defaultStage} + {@link timingsFromScore}
 * and hand the resulting Performance to the Performer's ScoreDrive.
 *
 * When the doc is a legacy NewsReportDoc, its music beds + SFX are recovered with
 * {@link newsReportAudio} and threaded into `compileScore`'s `{ audio }` channel so they
 * survive onto `Performance.audio` (and onto the studio timeline) instead of being stripped.
 * The studio surface (script editor, timeline narration/audio cues, voice, project name) is
 * also repopulated so an MCP client can preview/export the imported newscast — the same state
 * the legacy NewsReport import (applyProject) used to leave behind.
 */
async function applyScoreDoc(app: StudioContext, c: BridgeControllers, doc: unknown): Promise<{ beats: number; lowered: boolean }> {
  // Same guard as the file path (projectStore.applyProject): applying a newscast mid-take
  // swaps the avatar/lights/look/timeline under a running render — an automation client
  // issuing apply_newscast during an export must get a loud error, not a corrupted MP4.
  if (app.isBusy()) throw new Error('busy — finish the current take/export before applying a newscast.');
  let score: Score;
  let lowered = false;
  let nr: NewsReportDoc | undefined;
  try {
    score = validateScore(doc);
  } catch (scoreErr) {
    try {
      nr = validateNewsReportDoc(doc);
      score = compileNewsReportToScore(nr);
      lowered = true;
    } catch {
      // Surface the Score error (the preferred shape) when neither parses.
      throw scoreErr instanceof Error ? scoreErr : new Error(String(scoreErr));
    }
  }
  const stage = defaultStage(score.stage);
  // The coarse pre-TTS clock (Generate recompiles everything against the REAL clock later —
  // performer.buildAuthoredNarration). Beds/SFX/slides derive from the SAME timings via
  // newsReportChrome, so even the provisional pass sits on one clock, not three.
  const timings = timingsFromScore(score);
  const chrome = nr ? newsReportChrome(nr, timings) : undefined;
  const audio = chrome?.audio.length ? chrome.audio : undefined;
  // Resolve slide backdrop keys once so the Performance slides, the timeline graphics cues,
  // and the studio's url-keyed image cache all agree.
  const slides = chrome?.slides.map((s) => ({
    tSec: s.tSec,
    slide: { ...s.slide, ...(s.slide.image ? { image: resolveAssetUrl(s.slide.image) } : {}) },
  }));
  // Repopulate the studio surface FIRST: it fires performer.invalidateNarration (which clears any
  // prior authored Performance) BEFORE importScore lands the new one via performer.loadScore.
  // The order matters — otherwise the just-landed authored take would be immediately invalidated,
  // and preview/export would fall back to the script-derived rebuild.
  populateStudioFromScore(app, c, score, timings, audio, {
    name: nr?.meta.title,
    voiceId: nr?.meta.anchors[0]?.voiceId,
    slides,
  });
  // FULL chrome for a lowered NewsReportDoc — the SAME lowering + the SAME appliers the file
  // import uses (compileNewsReport → applyProject's calls), so the bridge and the file path
  // cannot drift: avatar, voice rate/pitch, look, lights/studio/idle/headline, backScreen.
  if (nr) await applyNewsChrome(app, c, nr);
  // Decode the imported audio cues' files so the LIVE preview actually plays them —
  // scheduleAudioCues plays from decoded buffers, and without this only the export (which
  // fetches per-cue itself) had the beds while the preview was silently music-less.
  if (audio?.length) {
    await c.timeline.loadAudioAssets(async (src) => {
      const r = await fetch(resolveAssetUrl(src));
      if (!r.ok) throw new Error(`asset ${r.status}`);
      return r.blob();
    });
  }
  if (slides?.length) await app.studio.preloadSlideImages(slides.map((s) => s.slide.image).filter((u): u is string => !!u));
  const perf = await c.projects.importScore(score, stage, timings, audio, { nr, slides });
  return { beats: perf.beats.length, lowered };
}

/**
 * Apply a NewsReportDoc's non-performance chrome through the SAME appliers projectStore's
 * applyProject uses — one lowering (compileNewsReport), two entry points, parity by
 * construction. The performance itself (beats/camera/gestures/slides/audio) is owned by the
 * Score pipeline; this handles only the studio-surface state the Score has no grammar for.
 */
async function applyNewsChrome(app: StudioContext, c: BridgeControllers, nr: NewsReportDoc): Promise<void> {
  const { project } = compileNewsReport(nr);
  const d = app.dom;
  c.voices.apply(project); // voiceId + rate + pitch
  d.emotionSel.value = project.emotion ?? 'neutral';
  app.avatar.setEmotion(d.emotionSel.value as never);
  c.lighting.apply(project); // studioOn / idleMotion / headline / lights
  c.look.apply(project);
  await c.library.apply(project); // avatarUrl (loads the anchor's avatar)
  c.backScreen.apply(project, r2Url);
}

/** Sanitize a title into a project-name token (mirrors projectStore's sanitize). */
function sanitizeName(n: string): string {
  return (n.trim() || 'untitled').replace(/[^\w.-]+/g, '_');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge for patch_newscast: plain objects merge recursively; arrays and scalars replace. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out;
}

/**
 * Repopulate the studio authoring surface from an imported Score so the newscast is
 * previewable/exportable: the script editor (joined beat text), the timeline narration cues
 * (laid out on the same per-beat clock) plus any recovered audio cues, the voice selector, and
 * the project name. Mirrors the state the legacy NewsReport import left via applyProject.
 */
function populateStudioFromScore(
  app: StudioContext,
  c: BridgeControllers,
  score: Score,
  timings: AudioTimings,
  audio: AudioCue[] | undefined,
  opts: { name?: string; voiceId?: string; slides?: { tSec: number; slide: SlideContent }[] },
): void {
  const d = app.dom;
  // Script editor: the spoken text, one beat per sentence. Fire 'input' so the overlay
  // highlighter / validity badge refresh, and invalidate any stale narration buffer.
  d.scriptEl.value = score.beats.map((b) => b.text).filter(Boolean).join(' ');
  d.scriptEl.dispatchEvent(new Event('input', { bubbles: true }));
  c.performer.invalidateNarration();

  // Voice: only adopt a voice that actually exists in the selector (else leave the current).
  if (opts.voiceId && [...d.voiceSel.options].some((o) => o.value === opts.voiceId)) {
    d.voiceSel.value = opts.voiceId;
    d.voiceSel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Project name.
  if (opts.name) d.projectNameEl.value = sanitizeName(opts.name);

  // Timeline: narration cues (one per beat, on the coarse pre-TTS clock) + recovered audio.
  const cues: Cue[] = [];
  for (let i = 0; i < score.beats.length; i++) {
    const beat = score.beats[i];
    const bt = timings.beats[i];
    if (!beat || !bt) continue;
    cues.push({
      id: cueId(),
      track: 'narration',
      type: 'narration',
      start: Math.round(bt.startSec * 10) / 10,
      duration: Math.round((bt.endSec - bt.startSec) * 10) / 10,
      text: beat.text,
      emotion: beat.emotion,
    });
  }
  if (audio) {
    for (const a of audio) {
      cues.push({
        id: a.id || cueId(),
        track: 'audio',
        type: 'audio.clip',
        start: a.start,
        duration: a.duration,
        src: a.src,
        volume: a.volume,
        fadeIn: a.fadeIn,
        fadeOut: a.fadeOut,
        label: a.label ?? a.kind,
      });
    }
  }
  // Wall slides → graphics cues so the editor shows the deck (the take itself is driven by
  // Performance.slides — same payloads, same clock).
  for (const s of opts.slides ?? []) {
    cues.push({ id: cueId(), track: 'graphics', type: 'graphic.slide', start: s.tSec, duration: 0, slide: s.slide });
  }
  const total = timings.beats.at(-1)?.endSec ?? 0;
  // Clean-slate import (NOT setNarrationCues, whose keep-audio/graphics merge is meant for a
  // live TTS re-take): repeated apply_newscast/patch_newscast used to accumulate duplicate
  // audio beds and keep the previous project's stale graphics/camera cues.
  c.timeline.importCues(cues, total);
}
