// Studio Bridge command dispatch.
//
// Maps every BridgeCommand (the contract in @las/protocol's bridge.ts) onto the
// already-constructed avatar-live controllers. We PREFER the typed controllers
// passed in from main.ts over DOM pokes or eval; we only touch the DOM where the
// UI itself does (e.g. a <select> whose change-handler owns the side effect).
//
// This module is self-contained and only imported when the bridge is enabled, so
// it never runs in the default (bridge-off) studio.
import { validateNewsReportDoc, validateScore, compileNewsReportToScore, newsReportAudio } from '@las/protocol';
import type { Stage, AudioTimings, Score, NewsReportDoc, AudioCue } from '@las/protocol';
import { SCREEN_STAND_POS } from '../scene/studio.js';
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
        // Merge the patch over the last-applied doc and re-import through the Score runtime.
        const base = (lastNewscast ?? {}) as Record<string, unknown>;
        const patch = (params.patch ?? {}) as Record<string, unknown>;
        const merged = { ...base, ...patch };
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
        if (typeof params.seek === 'number') seekTimeline(c, params.seek);
        const target = String(params.target);
        const canvas = target === 'output' ? app.stage.renderOutputFrame() : (d.stageEl.querySelector('canvas') as HTMLCanvasElement | null);
        if (!canvas) throw new Error('no canvas to capture');
        const blob = await blobFromCanvas(canvas);
        const saved = await uploadBlob('png', currentReqId(), blob);
        return { ...saved, width: canvas.width, height: canvas.height };
      }

      case 'preview': {
        c.timeline.startPreviewPublic();
        return { started: true };
      }

      case 'exportMp4': {
        const blob = await c.performer.exportMp4ToBlob();
        if (!blob) throw new Error('export produced no output');
        const saved = await uploadBlob('mp4', currentReqId(), blob);
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
let lastNewscast: unknown = null;
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
  // Compute timings once: the per-beat clock drives both the music-bed total length and the
  // word-anchor resolution, so the bed length matches the rendered take.
  const timings = timingsFromScore(score);
  const total = timings.beats.at(-1)?.endSec ?? 0;
  // Recover a lowered NewsReportDoc's beds/SFX (Score itself carries no audio). A pure Score
  // has no audio channel to recover, so audio stays undefined.
  const audio = nr ? newsReportAudio(nr, total) : undefined;
  const perf = await c.projects.importScore(score, stage, timings, audio);
  populateStudioFromScore(app, c, score, timings, audio, {
    name: nr?.meta.title,
    voiceId: nr?.meta.anchors[0]?.voiceId,
  });
  return { beats: perf.beats.length, lowered };
}

/** Sanitize a title into a project-name token (mirrors projectStore's sanitize). */
function sanitizeName(n: string): string {
  return (n.trim() || 'untitled').replace(/[^\w.-]+/g, '_');
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
  opts: { name?: string; voiceId?: string },
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
  const total = timings.beats.at(-1)?.endSec ?? 0;
  c.timeline.setNarrationCues(cues, total);
}
