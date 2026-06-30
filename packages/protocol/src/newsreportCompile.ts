import type { NewsReportDoc, Section, DocDefaults, PostProcessingSpec } from './newsreport.js';
import type { CameraCue } from './dsl.js';

// ── Structural mirrors of avatar-live's private types (compiler stays three.js-free) ──
export type PoseTuple = [number, number, number, number, number, number, number];

/** A PowerPoint-style wall slide (mirrors @las/protocol's SlideContent; the compiler stays
 *  three.js-free, so this is a structural copy rather than the zod type). */
export interface CompiledSlide {
  kicker: string;
  headline: string;
  bullets: string[];
  ticker: string;
  image?: string; // backdrop image src (URL or R2 key); resolved + preloaded by the studio
}

export interface CompiledCue {
  id: string;
  track: 'narration' | 'camera' | 'motion' | 'audio' | 'graphics';
  type: string;
  start: number;
  duration: number;
  pose?: PoseTuple;
  text?: string;
  gesture?: string;
  emotion?: string;
  label?: string;
  src?: string;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  slide?: CompiledSlide; // graphics cues carry the slide painted on the wall at `start`
}

export interface LookParams {
  bloomIntensity: number;
  bloomThreshold: number;
  contrast: number;
  saturation: number;
  vignetteOffset: number;
  vignetteDarkness: number;
  grain: number;
}

export interface CompiledProjectDoc {
  version: number;
  name: string;
  script: string;
  voiceId: string;
  rate: number;
  pitch: number;
  emotion: string;
  avatarUrl: string;
  shot: string;
  studioOn: boolean;
  idleMotion: boolean;
  headline: string;
  lights: { key: number; fill: number; rim: number; ambient: number; exposure: number; warmth: number; preset: string };
  look?: { preset?: string; params?: LookParams };
  backScreen: { kind: 'url' | 'r2'; src: string } | null;
  timeline: { duration: number; cues: CompiledCue[] };
}

const WPM = 130;
const CLOSE_SHOTS = ['close_up', 'extreme_close_up', 'medium_close'];
const WIDE_SHOTS = ['wide', 'full'];

// Lighting preset values mirror apps/avatar-live/src/app/lighting.ts LIGHT_PRESETS (kept in sync manually).
type LightValue = { key: number; fill: number; rim: number; ambient: number; warmth: number };
const STUDIO_LIGHT: LightValue = { key: 1.6, fill: 0.35, rim: 0.6, ambient: 0.45, warmth: 55 };
const LIGHT_VALUES: Record<string, LightValue> = {
  studio: STUDIO_LIGHT,
  soft: { key: 1.0, fill: 0.9, rim: 0.3, ambient: 0.85, warmth: 50 },
  dramatic: { key: 2.6, fill: 0.08, rim: 1.3, ambient: 0.12, warmth: 48 },
  warm: { key: 1.8, fill: 0.4, rim: 0.5, ambient: 0.5, warmth: 82 },
  cool: { key: 1.6, fill: 0.4, rim: 0.7, ambient: 0.5, warmth: 18 },
};
const LOOK_TO_LIGHT: Record<string, string> = {
  broadcast: 'studio', cinematic: 'dramatic', noir: 'dramatic', warm: 'warm', cool: 'cool', flat: 'soft', none: 'soft',
};
const DEFAULT_LOOK_PARAMS: LookParams = {
  bloomIntensity: 0.3, bloomThreshold: 0.85, contrast: 0.06, saturation: 0.06, vignetteOffset: 0.32, vignetteDarkness: 0.45, grain: 0.04,
};

function ensureTerminal(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : t + '.';
}
// A story-derived lower-third ticker, used when neither the section nor defaults author one.
// Replaces the studio's old HARDCODED "BREAKING · REALTIME 3D ANCHOR · …" string so the wall
// ticker always reflects the current story (the ticker bug fix).
export function defaultTicker(headline: string): string {
  return `${headline.toUpperCase()}  ·  LIVE`;
}
// round1/estDuration are exported so the Score path (scoreCompile.newsReportAudio) reuses the
// EXACT same timeline math — the two audio paths must stay byte-identical.
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
export function estDuration(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, (words * 60) / WPM);
}
function shotFor(cam: Partial<CameraCue> | undefined): 'close' | 'medium' | 'wide' {
  const shot = cam?.shot;
  if (shot && CLOSE_SHOTS.includes(shot)) return 'close';
  if (shot && WIDE_SHOTS.includes(shot)) return 'wide';
  return 'medium';
}
// A catalog shot-preset id → the studio cue type that resolves it (timeline/catalog.ts).
// close/medium/wide/two-shot reuse the existing size/angle cue types; the six new presets
// get their own data-driven cue types.
const PRESET_TO_CUE_TYPE: Record<string, string> = {
  close: 'cam.close',
  medium: 'cam.anchor',
  wide: 'cam.wide',
  'two-shot': 'cam.screen',
  'ots-screen': 'cam.otsScreen',
  profile: 'cam.profile',
  'hero-low': 'cam.heroLow',
  dutch: 'cam.dutch',
  establish: 'cam.establish',
  'push-in': 'cam.pushIn',
};

function cameraTypeFor(cam: Partial<CameraCue> | undefined): string {
  // A named catalog preset (direction-as-data) wins over the descriptive shot/move fields.
  const presetCue = cam?.preset ? PRESET_TO_CUE_TYPE[cam.preset] : undefined;
  if (presetCue) return presetCue;
  if (cam?.move === 'orbit_left' || cam?.move === 'orbit_right') return 'cam.orbit';
  const s = shotFor(cam);
  return s === 'close' ? 'cam.close' : s === 'wide' ? 'cam.wide' : 'cam.anchor';
}
function motionTypeFor(gesture: string): string {
  switch (gesture) {
    case 'wave': return 'motion.wave';
    case 'point': return 'motion.point';
    case 'nod': return 'motion.nod';
    default: return 'motion.explain';
  }
}
function lookParamsFromSpec(spec: PostProcessingSpec | undefined): LookParams {
  if (!spec) return { ...DEFAULT_LOOK_PARAMS };
  return {
    bloomIntensity: spec.bloomIntensity, bloomThreshold: spec.bloomThreshold, contrast: spec.contrast,
    saturation: spec.saturation, vignetteOffset: spec.vignetteOffset, vignetteDarkness: spec.vignetteDarkness, grain: spec.grain,
  };
}
function lightsFor(lookPreset: string, exposure: number) {
  const lightPreset = LOOK_TO_LIGHT[lookPreset] ?? 'studio';
  const v = LIGHT_VALUES[lightPreset] ?? LIGHT_VALUES.studio ?? STUDIO_LIGHT;
  return { key: v.key, fill: v.fill, rim: v.rim, ambient: v.ambient, exposure, warmth: v.warmth, preset: lightPreset };
}

/**
 * Lower a NewsReportDoc (v2) into the editor's ProjectDoc + Cue[]. Pure + deterministic.
 * Emits preset cam.* cue types only (no pose math — runtime poseFor() resolves them).
 * Camera = "replace + carry-forward"; emotion = sticky per section (re-seeded each section);
 * gesture = per-beat. Narration cues are advisory (Generate overwrites them).
 */
export function compileNewsReport(doc: NewsReportDoc): { project: CompiledProjectDoc; cues: CompiledCue[] } {
  const sections: Section[] = doc.rundown;
  const firstSection = sections[0]!; // rundown is min(1) per schema
  const d: Partial<DocDefaults> = doc.defaults ?? {};
  const anchor = doc.meta.anchors[0]!; // anchors is min(1) per schema
  const lookPreset = doc.look?.preset ?? 'broadcast';
  const exposure = doc.look?.exposure ?? 1.05;

  const initialSet = { ...(d.set ?? { mode: 'virtual' as const }), ...(firstSection.set ?? {}) };
  const defEmotion: string = d.emotion ?? 'neutral';

  const cues: CompiledCue[] = [];
  const scriptParts: string[] = [];
  let t = 0;
  let cueN = 0;
  const id = (p: string) => `${p}-${cueN++}`;
  let curCamera: Partial<CameraCue> | undefined = d.camera;
  let prevCamType: string | null = null;
  // An authored studio camera pose (DATA) → a single carried-forward cam.custom cue (explicit
  // pos/target/fov), suppressing the shot-bucket preset cam cues. PoseTuple = [px,py,pz, tx,ty,tz, fov].
  const cameraPoseTuple: PoseTuple | null = d.cameraPose
    ? [d.cameraPose.pos[0], d.cameraPose.pos[1], d.cameraPose.pos[2], d.cameraPose.target[0], d.cameraPose.target[1], d.cameraPose.target[2], d.cameraPose.fov]
    : null;
  let camPoseEmitted = false;
  let prevGesture: string | null = null;
  let firstEmotion = defEmotion;
  let firstCamera: Partial<CameraCue> | undefined = curCamera;
  let isFirstBeat = true;

  for (const section of sections) {
    if (section.cameraDefault) curCamera = section.cameraDefault;
    let curEmotion = defEmotion; // re-seed each section
    const sectionStart = t;

    // Wall slide for this section: emitted ONCE at the section's start so the on-screen
    // graphics swap (PowerPoint-style) in lockstep with the narration. The lower ticker is
    // story-derived (section → defaults → headline-derived default), never the old hardcoded
    // studio string. The optional backdrop image src is resolved + preloaded by the studio.
    const slideHeadline = section.headline ?? doc.meta.title;
    const slideTicker = section.ticker ?? d.ticker ?? defaultTicker(slideHeadline);
    const slide: CompiledSlide = {
      kicker: 'LIVE',
      headline: slideHeadline,
      bullets: section.bullets ?? [],
      ticker: slideTicker,
    };
    if (section.graphic) slide.image = section.graphic.src;
    cues.push({ id: id('gfx'), track: 'graphics', type: 'graphic.slide', start: round1(sectionStart), duration: 0, slide });

    for (const beat of section.beats) {
      if (beat.emotion) curEmotion = beat.emotion;
      if (beat.camera) curCamera = beat.camera;
      const gesture: string = beat.gesture ?? d.gesture ?? 'none';
      if (isFirstBeat) { firstEmotion = curEmotion; firstCamera = curCamera; isFirstBeat = false; }

      scriptParts.push(`[${curEmotion}][${gesture}] ${ensureTerminal(beat.text)}`);

      const dur = estDuration(beat.text);
      cues.push({ id: id('nar'), track: 'narration', type: 'narration', start: round1(t), duration: round1(dur), text: ensureTerminal(beat.text), gesture, emotion: curEmotion });

      if (cameraPoseTuple) {
        if (!camPoseEmitted) {
          cues.push({ id: id('cam'), track: 'camera', type: 'cam.custom', start: round1(t), duration: 1.2, pose: cameraPoseTuple });
          camPoseEmitted = true;
        }
      } else {
        const camType = cameraTypeFor(curCamera);
        if (camType !== prevCamType) {
          cues.push({ id: id('cam'), track: 'camera', type: camType, start: round1(t), duration: 1.2 });
          prevCamType = camType;
        }
      }
      if (gesture !== 'none' && gesture !== prevGesture) {
        cues.push({ id: id('mot'), track: 'motion', type: motionTypeFor(gesture), start: round1(t), duration: 1.0 });
      }
      prevGesture = gesture;

      t += dur + (beat.pause_ms_after ?? 0) / 1000;
    }

    for (const a of section.audio) {
      cues.push({
        id: id('aud'), track: 'audio', type: 'audio.clip', start: round1(sectionStart + a.start),
        duration: round1(a.duration), src: a.src, volume: a.volume, fadeIn: a.fadeIn, fadeOut: a.fadeOut, label: a.label ?? a.kind,
      });
    }
  }

  const totalDuration = round1(t);
  if (d.music) {
    cues.push({
      id: id('aud'), track: 'audio', type: 'audio.clip', start: 0, duration: totalDuration,
      src: d.music.src, volume: d.music.volume, fadeIn: d.music.fadeIn, fadeOut: d.music.fadeOut, label: 'music bed',
    });
  }

  const project: CompiledProjectDoc = {
    version: 2,
    name: doc.meta.title,
    script: scriptParts.join(' '),
    voiceId: anchor.voiceId,
    rate: anchor.rate ?? 1,
    pitch: anchor.pitch ?? 1,
    emotion: firstEmotion,
    avatarUrl: anchor.avatarUrl,
    shot: shotFor(firstCamera),
    studioOn: initialSet.mode !== 'real',
    idleMotion: d.idleMotion ?? false,
    headline: firstSection.headline ?? d.headline ?? doc.meta.title,
    lights: lightsFor(lookPreset, exposure),
    look: doc.look ? { preset: lookPreset, params: lookParamsFromSpec(doc.look) } : undefined,
    backScreen: initialSet.backScreen ?? null,
    timeline: { duration: totalDuration, cues },
  };

  return { project, cues };
}
