// Studio Bridge command dispatch.
//
// Maps every BridgeCommand (the contract in @las/protocol's bridge.ts) onto the
// already-constructed avatar-live controllers. We PREFER the typed controllers
// passed in from main.ts over DOM pokes or eval; we only touch the DOM where the
// UI itself does (e.g. a <select> whose change-handler owns the side effect).
//
// This module is self-contained and only imported when the bridge is enabled, so
// it never runs in the default (bridge-off) studio.
import { validateNewsReportDoc } from '@las/protocol';
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
      case 'applyNewscast': {
        const title = await c.projects.importNewsReport(params.doc);
        lastNewscast = params.doc;
        return { applied: true, title };
      }
      case 'validateNewscast': {
        try {
          const doc = validateNewsReportDoc(params.doc);
          return { valid: true, title: doc.meta.title };
        } catch (err) {
          return { valid: false, error: String(err instanceof Error ? err.message : err) };
        }
      }
      case 'patchNewscast': {
        // Merge the patch over the last-applied doc, re-validate, re-import.
        const base = (lastNewscast ?? {}) as Record<string, unknown>;
        const patch = (params.patch ?? {}) as Record<string, unknown>;
        const merged = { ...base, ...patch };
        validateNewsReportDoc(merged); // throw early on an invalid merge
        const title = await c.projects.importNewsReport(merged);
        lastNewscast = merged;
        return { applied: true, title };
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
