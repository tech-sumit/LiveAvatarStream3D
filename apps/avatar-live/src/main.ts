import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Stage, type Shot } from './scene/stage.js';
import { buildNewsStudio } from './scene/studio.js';
import { AvatarController } from './avatar/avatarController.js';
import { BoundaryLipsync } from './lipsync/boundaryLipsync.js';
import { AudioAnalyserLipsync } from './lipsync/audioLipsync.js';
import { WebSpeechTts } from './tts/webSpeech.js';
import { ServerTts } from './tts/serverTts.js';
import { ElevenLabsTts } from './tts/elevenLabs.js';
import { RealtimeSession } from './session/realtimeSession.js';
import { Recorder } from './capture/recorder.js';
import { resolveGesture, selectTalkClip, type Gesture } from './avatar/gestures.js';
import { TimelinePlayer } from './timeline/player.js';
import { TimelineUI } from './timeline/ui.js';
import { poseToTuple } from './timeline/catalog.js';
import { cueId, type PoseTuple, type Timeline } from './timeline/types.js';
import type { EmotionName } from './avatar/emotion.js';
import type { TtsSource } from './tts/types.js';

// ── DOM ────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stageEl = $('stage');
const scriptEl = $<HTMLTextAreaElement>('script');
const liveEl = $<HTMLTextAreaElement>('liveLine');
const speakBtn = $<HTMLButtonElement>('speak');
const stopBtn = $<HTMLButtonElement>('stop');
const voiceSel = $<HTMLSelectElement>('voice');
const rateEl = $<HTMLInputElement>('rate');
const pitchEl = $<HTMLInputElement>('pitch');
const emotionSel = $<HTMLSelectElement>('emotion');
const shotSel = $<HTMLSelectElement>('shot');
const glbInput = $<HTMLInputElement>('glb');
const avatarSel = $<HTMLSelectElement>('avatarSel');
const glbUrlInput = $<HTMLInputElement>('glbUrl');
const resetViewBtn = $<HTMLButtonElement>('resetView');
const centerAvatarBtn = $<HTMLButtonElement>('centerAvatar');
const gizmoBtn = $<HTMLButtonElement>('gizmoBtn');
const gizmoModesEl = $<HTMLDivElement>('gizmoModes');
const moveModeBtn = $<HTMLButtonElement>('moveMode');
const rotateModeBtn = $<HTMLButtonElement>('rotateMode');
const loadUrlBtn = $<HTMLButtonElement>('loadUrl');
const recordBtn = $<HTMLButtonElement>('record');
const downloadEl = $<HTMLAnchorElement>('download');
const statusEl = $<HTMLSpanElement>('avatarStatus');
const logEl = $<HTMLPreElement>('log');
const pipFrameEl = $<HTMLDivElement>('pipFrame');
const captureFormatSel = $<HTMLSelectElement>('captureFormat');
const gateLabelEl = $<HTMLSpanElement>('gateLabel');
const studioToggle = $<HTMLButtonElement>('studioToggle');
const idleMotionToggle = $<HTMLButtonElement>('idleMotionToggle');
const headlineInput = $<HTMLInputElement>('headline');
const lightPresetSel = $<HTMLSelectElement>('lightPreset');
const lightKey = $<HTMLInputElement>('lightKey');
const lightFill = $<HTMLInputElement>('lightFill');
const lightRim = $<HTMLInputElement>('lightRim');
const lightAmbient = $<HTMLInputElement>('lightAmbient');
const exposureEl = $<HTMLInputElement>('exposure');
const warmthEl = $<HTMLInputElement>('warmth');

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = `[${ts}] ${msg}\n${logEl.textContent ?? ''}`.slice(0, 4000);
}

// ── Scene + avatar ───────────────────────────────────────────────────────────
const stage = new Stage(stageEl);
const studio = buildNewsStudio();
stage.add(studio.group);
const avatar = new AvatarController();
avatar.setRenderer(stage.renderer);
stage.add(avatar.group);
stage.frame(avatar.headCenter, avatar.headHeight, shotSel.value as Shot);
statusEl.textContent = avatar.description;

// Shared AudioContext + a MediaStream destination so the voice (Web Audio) can
// be mixed into recordings. Created on the first user gesture (autoplay policy).
let sharedCtx: AudioContext | null = null;
let recordDest: MediaStreamAudioDestinationNode | null = null;
function audioCtx(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new AudioContext();
    recordDest = sharedCtx.createMediaStreamDestination();
  }
  return sharedCtx;
}

// Shared loader for the default avatar, file uploads, and URL loads.
async function loadAvatar(url: string, label: string): Promise<boolean> {
  log(`loading ${label}…`);
  try {
    const res = await avatar.loadGltf(url);
    if (res.mode === 'none') {
      log(`⚠ ${label}: ${res.detail}. Use an ARKit/Oculus-blendshape avatar (e.g. Ready Player Me).`);
      return false;
    }
    avatar.setPosition(0, 0, 0);
    avatar.group.quaternion.identity();
    stage.frame(avatar.headCenter, avatar.headHeight, shotSel.value as Shot);
    statusEl.textContent = avatar.description;
    log(`loaded ${label} — ${res.detail}`);
    if (res.mode === 'jawbone') log('note: jaw-bone lipsync is open/close only (no visemes/expression).');
    await setupBodyAnimation();
    return true;
  } catch (err) {
    log(`failed to load ${label}: ${String(err)}`);
    return false;
  }
}

// Body/gesture animation (Ready Player Me avatars only — RPM animation library
// is licensed for use with RPM avatars). Clips are fetched locally, not bundled.
// Per-segment gestures are mapped to clips via GESTURE_CLIPS (see onSegmentStart).
async function setupBodyAnimation(): Promise<void> {
  if (!avatar.isReadyPlayerMe) {
    log('body animation: skipped (needs a Ready Player Me avatar).');
    return;
  }
  const got = await avatar.loadAnimations([
    { name: 'idle', url: '/animations/idle.glb' },
    { name: 'idle_calm', url: '/animations/idle_calm.glb' },
    { name: 'talk1', url: '/animations/talk1.glb' },
    { name: 'talk2', url: '/animations/talk2.glb' },
    { name: 'talk3', url: '/animations/talk3.glb' },
    { name: 'talk4', url: '/animations/talk4.glb' },
    { name: 'talk5', url: '/animations/talk5.glb' },
  ]);
  if (got.includes('idle')) avatar.playClip('idle', 0);
  log(
    got.length
      ? `body animation: ${got.length} clips (${got.join(', ')})`
      : 'body animation: no clips found — run scripts/fetch-animations.sh',
  );
}

// Default avatar: a textured Ready Player Me human (from the MIT-licensed
// met4citizen/talkinghead repo) with full ARKit + Oculus viseme blendshapes.
// Falls back to the facecap head scan, then the procedural head.
void (async () => {
  // Avaturn (photoreal) is the default — ideal for the head-and-shoulders anchor
  // framing. Its bind pose differs slightly from the RPM animation clips, so for
  // full-body wide shots brunette (RPM) retargets more cleanly; both selectable.
  const order: [string, string][] = [
    ['/avatars/avaturn.glb', 'Avaturn (photoreal)'],
    ['/avatars/brunette.glb', 'Ready Player Me'],
    ['/avatars/human.glb', 'facecap'],
  ];
  for (const [url, label] of order) {
    if (await loadAvatar(url, label)) {
      avatarSel.value = url;
      return;
    }
  }
  log('using procedural head — run scripts/fetch-avatars.sh for photoreal avatars.');
})();

// ── Lipsync state ────────────────────────────────────────────────────────────
const boundary = new BoundaryLipsync(Number(rateEl.value));
let analyser: AudioAnalyserLipsync | null = null;
let speaking = false;
let lastTalkClip = 'idle';

// Synced render state (pre-generated audio → lipsync + motion driven off one clock).
interface RenderState {
  ctx: AudioContext;
  start: number;
  analyser: AudioAnalyserLipsync;
  timeline: { t: number; gesture: string; emotion?: string }[];
  idx: number;
}
let render: RenderState | null = null;

// ── Director timeline (camera + motion choreography) ─────────────────────────
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
const timeline = demoTimeline();
const player = new TimelinePlayer(stage, avatar);
player.setClipPlayer((name) => {
  if (avatar.animationClips.length) {
    lastTalkClip = name;
    avatar.playClip(name);
  }
});
player.load(timeline);
let timelineUI: TimelineUI | null = null;
let previewStart: number | null = null;
let playheadT = 0; // current timeline time (preview/seek) — where new cues are added
let camRec: { start: number; buf: { t: number; p: PoseTuple }[]; last: number; at: number } | null = null;

const ttsOpts = () => ({
  voiceId: voiceSel.value || undefined,
  rate: Number(rateEl.value),
  pitch: Number(pitchEl.value),
});

stage.onFrame((dt) => {
  // Camera-path recording: sample the live camera ~30fps while the user navigates.
  if (camRec) {
    const rt = performance.now() / 1000 - camRec.start;
    if (rt - camRec.last >= 1 / 30) {
      camRec.last = rt;
      camRec.buf.push({ t: rt, p: poseToTuple(stage.getCameraPose()) });
    }
  }

  // Timeline preview (no audio): play the camera/motion choreography.
  if (previewStart != null) {
    const t = performance.now() / 1000 - previewStart;
    if (t >= timeline.duration) {
      stopPreview();
    } else {
      playheadT = t;
      player.update(t);
      timelineUI?.setPlayhead(t);
      avatar.setSilent();
      avatar.setGazeTarget(stage.cameraWorldPosition());
      avatar.update(dt);
      return;
    }
  }

  if (render) {
    // Drive lipsync + motion from the pre-generated audio's clock — frame-exact
    // sync with the captured audio, both rendered from the same timeline.
    const t = render.ctx.currentTime - render.start;
    if (t >= 0) {
      if (player.hasCameraCues()) player.update(t); // director camera + motion, synced
      avatar.setMouth(render.analyser.sample());
      avatar.setGazeTarget(stage.cameraWorldPosition());
      while (render.idx + 1 < render.timeline.length && render.timeline[render.idx + 1].t <= t) {
        render.idx++;
        const seg = render.timeline[render.idx];
        const emo = (seg.emotion as EmotionName) ?? (emotionSel.value as EmotionName);
        avatar.setEmotion(emo);
        if (avatar.animationClips.length) {
          lastTalkClip = selectTalkClip(seg.gesture as Gesture, emo, lastTalkClip);
          avatar.playClip(lastTalkClip);
        }
      }
    }
    avatar.update(dt);
    return;
  }
  if (speaking) {
    avatar.setMouth(analyser ? analyser.sample() : boundary.sample(performance.now()));
  } else {
    avatar.setSilent();
  }
  avatar.setGazeTarget(speaking ? stage.cameraWorldPosition() : null);
  avatar.update(dt);
});

// ── TTS source selection ─────────────────────────────────────────────────────
// Default to browser Web Speech; asynchronously upgrade to ElevenLabs if the
// proxy + ELEVENLABS_API_KEY are configured (see vite.config.ts). `activeTts` is
// read through a getter by the session, so the swap takes effect immediately.
const serverTtsUrl = import.meta.env.VITE_TTS_URL as string | undefined;
let activeTts: TtsSource = WebSpeechTts.supported()
  ? new WebSpeechTts()
  : serverTtsUrl
    ? new ServerTts(serverTtsUrl)
    : new WebSpeechTts();

void (async () => {
  if (await ElevenLabsTts.available()) {
    activeTts = new ElevenLabsTts('/eleven', audioCtx, () => recordDest);
    log('voice: ElevenLabs (real TTS) — lip-sync from the actual waveform');
  } else {
    log('voice: browser (Web Speech). Add ELEVENLABS_API_KEY to apps/avatar-live/.env for ElevenLabs.');
  }
  await populateVoices();
})();

async function populateVoices(): Promise<void> {
  voiceSel.innerHTML = '';
  if (!activeTts.listVoices) return;
  const voices = await activeTts.listVoices();
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    voiceSel.appendChild(opt);
  }
  // For Web Speech, default to an English voice; ElevenLabs voices are all usable.
  if (activeTts.kind === 'web-speech') {
    const en = voices.find((v) => /en[-_]/i.test(v.id) || /English/i.test(v.label));
    if (en) voiceSel.value = en.id;
  }
}

// ── Session ──────────────────────────────────────────────────────────────────
const session = new RealtimeSession(
  () => activeTts,
  ttsOpts,
  {
    onWord: (word, atMs) => {
      speaking = true;
      boundary.noteWord(word, atMs);
    },
    onAudioNode: (ctx, node) => {
      // Cloned-voice path: drive lipsync from the real waveform.
      analyser = new AudioAnalyserLipsync(ctx, node);
      speaking = true;
    },
    onSegmentStart: (_text, gesture, emotion) => {
      speaking = true;
      // Inline [emotion] directive in the script overrides the dropdown for this segment.
      const emo = (emotion as EmotionName) ?? (emotionSel.value as EmotionName);
      if (emotion) avatar.setEmotion(emo);
      if (avatar.animationClips.length) {
        lastTalkClip = selectTalkClip((gesture as Gesture) ?? 'explain', emo, lastTalkClip);
        avatar.playClip(lastTalkClip);
      }
    },
    onIdle: () => {
      speaking = false;
      if (avatar.animationClips.length) avatar.playClip('idle');
      analyser = null;
      log('idle');
      setSpeakingUi(false);
    },
    onStatus: (m) => log(m),
  },
  resolveGesture,
);

// ── Controls ─────────────────────────────────────────────────────────────────
speakBtn.addEventListener('click', () => {
  boundary.setRate(Number(rateEl.value));
  session.start(scriptEl.value);
  setSpeakingUi(true);
});
stopBtn.addEventListener('click', () => {
  session.stop();
  speaking = false;
  analyser = null;
  setSpeakingUi(false);
  log('stopped (barge-in)');
});
liveEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const line = liveEl.value.trim();
    if (!line) return;
    boundary.setRate(Number(rateEl.value));
    session.enqueue(line);
    setSpeakingUi(true);
    log(`streamed in: "${line}"`);
    liveEl.value = '';
  }
});

emotionSel.addEventListener('change', () => {
  avatar.setEmotion(emotionSel.value as EmotionName);
  log(`emotion → ${emotionSel.value}`);
});
avatar.setEmotion(emotionSel.value as EmotionName);

shotSel.addEventListener('change', () => stage.frame(avatar.headCenter, avatar.headHeight, shotSel.value as Shot));
rateEl.addEventListener('input', () => boundary.setRate(Number(rateEl.value)));

resetViewBtn.addEventListener('click', () =>
  stage.frame(avatar.headCenter, avatar.headHeight, shotSel.value as Shot, true),
);
centerAvatarBtn.addEventListener('click', () => {
  avatar.setPosition(0, 0, 0);
  avatar.group.quaternion.identity();
  syncGizmoToAvatar();
});

// ── 3D transform gizmo (Unity/Unreal-style) — move/rotate the avatar in the
// viewport. The handle rides a proxy at chest height (the avatar's own origin is
// at the feet, off-screen in head shots); dragging maps back to the avatar.
// Rotate is Y-only (turn left/right), which keeps the chest above the feet so the
// position mapping stays valid. Orbit is disabled while dragging.
const gizmoProxy = new THREE.Object3D();
stage.add(gizmoProxy);
let chestY = 1.15;
function syncGizmoToAvatar(): void {
  chestY = Math.max(0.5, avatar.headCenter.y - 0.45);
  gizmoProxy.position.set(avatar.group.position.x, avatar.group.position.y + chestY, avatar.group.position.z);
  gizmoProxy.quaternion.copy(avatar.group.quaternion);
}

const gizmo = new TransformControls(stage.camera, stage.renderer.domElement);
gizmo.setSpace('local');
gizmo.setSize(2.0);
gizmo.attach(gizmoProxy);
gizmo.visible = false;
gizmo.enabled = false;
stage.add(gizmo);
stage.excludeFromCapture(gizmo); // never in the recorded output
gizmo.addEventListener('dragging-changed', (e) => {
  stage.controls.enabled = !(e as unknown as { value: boolean }).value;
});
gizmo.addEventListener('objectChange', () => {
  avatar.setPosition(gizmoProxy.position.x, gizmoProxy.position.y - chestY, gizmoProxy.position.z);
  avatar.group.quaternion.copy(gizmoProxy.quaternion);
});

function setGizmoMode(mode: 'translate' | 'rotate'): void {
  gizmo.setMode(mode);
  gizmo.showX = gizmo.showZ = mode === 'translate';
  gizmo.showY = true; // rotate = Y-turn only; translate = all axes
  moveModeBtn.classList.toggle('primary', mode === 'translate');
  rotateModeBtn.classList.toggle('primary', mode === 'rotate');
}
function setGizmoOn(on: boolean): void {
  if (on) {
    syncGizmoToAvatar();
    stage.frame(avatar.headCenter, avatar.headHeight, 'wide', true); // reveal the avatar + gizmo
    shotSel.value = 'wide';
  }
  gizmo.visible = on;
  gizmo.enabled = on;
  gizmoBtn.classList.toggle('primary', on);
  gizmoModesEl.hidden = !on;
}
let gizmoOn = false;
setGizmoMode('translate');
gizmoBtn.addEventListener('click', () => {
  gizmoOn = !gizmoOn;
  setGizmoOn(gizmoOn);
});
moveModeBtn.addEventListener('click', () => setGizmoMode('translate'));
rotateModeBtn.addEventListener('click', () => setGizmoMode('rotate'));
// Unity-style hotkeys: W = move, E = rotate, G = toggle gizmo, Esc = hide.
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === 'g' || e.key === 'G') {
    gizmoOn = !gizmoOn;
    setGizmoOn(gizmoOn);
  } else if (e.key === 'Escape') {
    gizmoOn = false;
    setGizmoOn(false);
  } else if (gizmoOn && (e.key === 'w' || e.key === 'W')) {
    setGizmoMode('translate');
  } else if (gizmoOn && (e.key === 'e' || e.key === 'E')) {
    setGizmoMode('rotate');
  }
});

// ── News studio & lighting ───────────────────────────────────────────────────
let studioOn = true;
studioToggle.addEventListener('click', () => {
  studioOn = !studioOn;
  studio.group.visible = studioOn;
  studioToggle.textContent = `Studio: ${studioOn ? 'On' : 'Off'}`;
  studioToggle.classList.toggle('primary', studioOn);
});
headlineInput.addEventListener('input', () => {
  const v = headlineInput.value.trim();
  if (v) studio.setHeadline(v);
});

// Idle motion (breathing/sway) — default OFF so the anchor holds still.
let idleMotionOn = false;
avatar.setIdleMotion(false);
idleMotionToggle.addEventListener('click', () => {
  idleMotionOn = !idleMotionOn;
  avatar.setIdleMotion(idleMotionOn);
  idleMotionToggle.textContent = `Idle motion: ${idleMotionOn ? 'On' : 'Off'}`;
  idleMotionToggle.classList.toggle('primary', idleMotionOn);
});

function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
function applyLights(): void {
  stage.setLightIntensity('key', Number(lightKey.value));
  stage.setLightIntensity('fill', Number(lightFill.value));
  stage.setLightIntensity('rim', Number(lightRim.value));
  stage.setLightIntensity('ambient', Number(lightAmbient.value));
  stage.setExposure(Number(exposureEl.value));
  // Warmth 0 (cool blue) → 100 (warm amber) on the key light.
  stage.setLightColor('key', mixColor(0xcfe0ff, 0xffcf8e, Number(warmthEl.value) / 100));
}
[lightKey, lightFill, lightRim, lightAmbient, exposureEl, warmthEl].forEach((el) =>
  el.addEventListener('input', applyLights),
);

const LIGHT_PRESETS: Record<string, { key: number; fill: number; rim: number; amb: number; exp: number; warm: number }> = {
  studio: { key: 1.6, fill: 0.35, rim: 0.6, amb: 0.45, exp: 1.05, warm: 55 },
  soft: { key: 1.0, fill: 0.9, rim: 0.3, amb: 0.85, exp: 1.1, warm: 50 },
  dramatic: { key: 2.6, fill: 0.08, rim: 1.3, amb: 0.12, exp: 1.0, warm: 48 },
  warm: { key: 1.8, fill: 0.4, rim: 0.5, amb: 0.5, exp: 1.05, warm: 82 },
  cool: { key: 1.6, fill: 0.4, rim: 0.7, amb: 0.5, exp: 1.0, warm: 18 },
};
lightPresetSel.addEventListener('change', () => {
  const p = LIGHT_PRESETS[lightPresetSel.value];
  if (!p) return;
  lightKey.value = String(p.key);
  lightFill.value = String(p.fill);
  lightRim.value = String(p.rim);
  lightAmbient.value = String(p.amb);
  exposureEl.value = String(p.exp);
  warmthEl.value = String(p.warm);
  applyLights();
  log(`light preset: ${lightPresetSel.value}`);
});
applyLights();

// ── Capture format (recording size) ──────────────────────────────────────────
const CAPTURE_FORMATS = [
  { name: '1080p (16:9)', w: 1920, h: 1080 },
  { name: '1440p (16:9)', w: 2560, h: 1440 },
  { name: '4K UHD (16:9)', w: 3840, h: 2160 },
  { name: '720p (16:9)', w: 1280, h: 720 },
  { name: 'vertical 1080×1920 (9:16)', w: 1080, h: 1920 },
  { name: 'square 1080 (1:1)', w: 1080, h: 1080 },
];
CAPTURE_FORMATS.forEach((f, i) => {
  const o = document.createElement('option');
  o.value = String(i);
  o.textContent = `${f.name} — ${f.w}×${f.h}`;
  captureFormatSel.appendChild(o);
});
function applyCaptureFormat(): void {
  const f = CAPTURE_FORMATS[Number(captureFormatSel.value)] ?? CAPTURE_FORMATS[0];
  stage.setCaptureFormat(f);
  gateLabelEl.textContent = `${f.w}×${f.h}`;
}
captureFormatSel.addEventListener('change', applyCaptureFormat);
applyCaptureFormat();

glbInput.addEventListener('change', async () => {
  const file = glbInput.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    await loadAvatar(url, file.name);
  } finally {
    URL.revokeObjectURL(url);
  }
});

avatarSel.addEventListener('change', () => {
  void loadAvatar(avatarSel.value, avatarSel.selectedOptions[0]?.text ?? 'avatar');
});

loadUrlBtn.addEventListener('click', () => {
  const url = glbUrlInput.value.trim();
  if (url) void loadAvatar(url, url.split('/').pop() || 'url');
});
glbUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadUrlBtn.click();
});

// ── Recording / render ───────────────────────────────────────────────────────
// Synced render (ElevenLabs): synthesize the WHOLE script up front, concatenate
// into one audio buffer + a motion timeline, then play it once while capturing —
// lipsync + gestures + audio all driven from a single clock, so the exported
// video is frame-synced (not audio bolted onto live video). Web Speech (no
// pre-synthesis) falls back to live capture while you press Speak.
const recorder = new Recorder(
  () => stage.captureStream(30),
  () => recordDest?.stream.getAudioTracks()[0] ?? null,
);
let renderSrc: AudioBufferSourceNode | null = null;

function setRecUi(on: boolean): void {
  recordBtn.textContent = on ? '■ Stop recording' : '● Record camera';
  recordBtn.classList.toggle('rec', on);
  pipFrameEl.classList.toggle('rec', on);
}
function downloadClip(url: string, filename: string): void {
  if (!url) return;
  downloadEl.href = url;
  downloadEl.download = filename;
  downloadEl.textContent = `⬇ Download ${filename}`;
  downloadEl.hidden = false;
  downloadEl.click();
  log(`clip ready — downloading ${filename}`);
}
function monoData(b: AudioBuffer): Float32Array {
  if (b.numberOfChannels === 1) return b.getChannelData(0);
  const out = new Float32Array(b.length);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < b.length; i++) out[i] += d[i] / b.numberOfChannels;
  }
  return out;
}

async function renderVideo(): Promise<void> {
  session.stop();
  const lines = scriptEl.value
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) {
    log('nothing to render — script is empty.');
    return;
  }
  const segs = lines.map(resolveGesture);
  const ctx = audioCtx();
  await ctx.resume();

  recordBtn.disabled = true;
  log(`render: synthesizing ${segs.length} segment(s)…`);
  const buffers: AudioBuffer[] = [];
  try {
    for (const s of segs) buffers.push(await activeTts.synthesize!(s.text, ttsOpts()));
  } catch (err) {
    log(`render failed (TTS): ${String(err)}`);
    recordBtn.disabled = false;
    return;
  }

  // Concatenate into one buffer (with a short gap between sentences) + timeline.
  const sr = buffers[0].sampleRate;
  const gap = Math.round(sr * 0.18);
  const total = buffers.reduce((a, b) => a + b.length + gap, 0);
  const out = ctx.createBuffer(1, total, sr);
  const od = out.getChannelData(0);
  const segTimeline: { t: number; gesture: string; emotion?: string }[] = [];
  let off = 0;
  buffers.forEach((b, i) => {
    od.set(monoData(b), off);
    segTimeline.push({ t: off / sr, gesture: segs[i].gesture, emotion: segs[i].emotion });
    off += b.length + gap;
  });
  recordBtn.disabled = false;

  // Audio graph: buffer → gain → speakers + record destination + analyser.
  const srcNode = ctx.createBufferSource();
  srcNode.buffer = out;
  const gain = ctx.createGain();
  srcNode.connect(gain);
  gain.connect(ctx.destination);
  if (recordDest) gain.connect(recordDest);
  const ana = new AudioAnalyserLipsync(ctx, gain);

  try {
    recorder.start();
  } catch (err) {
    log(`record start failed: ${String(err)}`);
    return;
  }
  setRecUi(true);
  downloadEl.hidden = true;
  log(`render: recording ${stage.captureLabel()} · ${(total / sr).toFixed(1)}s …`);

  renderSrc = srcNode;
  render = { ctx, start: ctx.currentTime + 0.08, analyser: ana, timeline: segTimeline, idx: -1 };
  const directing = player.hasCameraCues();
  if (directing) player.begin(); // camera/motion choreography, synced + captured
  srcNode.onended = async () => {
    render = null;
    renderSrc = null;
    if (directing) player.end();
    avatar.setSilent();
    avatar.setGazeTarget(null);
    if (avatar.animationClips.length) avatar.playClip('idle');
    const { url, filename } = await recorder.stop();
    setRecUi(false);
    downloadClip(url, filename);
  };
  srcNode.start(render.start);
}

recordBtn.addEventListener('click', () => {
  if (render) {
    try {
      renderSrc?.stop(); // ends early → onended exports what's captured
    } catch {
      /* already stopped */
    }
    return;
  }
  if (recorder.active) {
    // live (Web Speech) capture in progress → stop + export
    void recorder.stop().then(({ url, filename }) => {
      setRecUi(false);
      downloadClip(url, filename);
    });
    return;
  }
  audioCtx();
  if (activeTts.synthesize) {
    void renderVideo();
  } else {
    // Web Speech fallback: live capture; press Speak to perform, Stop record to save.
    try {
      recorder.start();
      setRecUi(true);
      downloadEl.hidden = true;
      log(`recording live ${stage.captureLabel()} — press Speak to perform.`);
    } catch (err) {
      log(`recording failed to start: ${String(err)}`);
    }
  }
});

function setSpeakingUi(on: boolean): void {
  speakBtn.disabled = on;
  stopBtn.disabled = !on;
}

// ── Director timeline UI + preview ───────────────────────────────────────────
const timelineEl = $<HTMLDivElement>('timeline');
const timelineToggle = $<HTMLButtonElement>('timelineToggle');
timelineToggle.addEventListener('click', () => {
  const open = timelineEl.classList.toggle('open');
  stageEl.classList.toggle('tl-open', open); // lift the OUTPUT preview above the panel
  if (open && !timelineUI) {
    timelineUI = new TimelineUI(timelineEl, timeline, {
      onChange: () => player.load(timeline),
      onPreview: togglePreview,
      onStop: stopPreview,
      onSeek: seekPreview,
      onCapturePose: captureCameraCue,
      onRecordPath: toggleCameraRecord,
    });
  }
  timelineToggle.classList.toggle('primary', open);
  if (!open) stopPreview();
});

function startPreview(): void {
  if (previewStart != null) return;
  player.begin();
  previewStart = performance.now() / 1000;
  timelineUI?.setPlaying(true);
}
function stopPreview(): void {
  if (previewStart == null) return;
  previewStart = null;
  player.end();
  timelineUI?.setPlaying(false);
  timelineUI?.setPlayhead(0);
}
function togglePreview(): void {
  if (previewStart != null) stopPreview();
  else startPreview();
}
function seekPreview(t: number): void {
  if (previewStart == null) startPreview();
  previewStart = performance.now() / 1000 - t;
  playheadT = t;
}

// Capture the current (orbit/arrow-navigated) view as a Custom-view camera cue.
function captureCameraCue(): void {
  timeline.cues.push({
    id: cueId(),
    track: 'camera',
    type: 'cam.custom',
    start: Math.round(playheadT * 10) / 10,
    duration: 1.5,
    pose: poseToTuple(stage.getCameraPose()),
  });
  player.load(timeline);
  timelineUI?.refresh();
  log(`captured camera view as a cue @ ${playheadT.toFixed(1)}s.`);
}

// Record a free camera move (orbit + arrow keys) → a replayable cam.path cue.
function toggleCameraRecord(): void {
  if (camRec) {
    const buf = camRec.buf;
    const at = camRec.at;
    const dur = buf.length ? buf[buf.length - 1].t : 0;
    camRec = null;
    timelineUI?.setRecording(false);
    if (buf.length > 1) {
      timeline.cues.push({ id: cueId(), track: 'camera', type: 'cam.path', start: at, duration: dur, path: buf });
      player.load(timeline);
      timelineUI?.refresh();
      log(`recorded camera move (${dur.toFixed(1)}s) @ ${at.toFixed(1)}s.`);
    } else {
      log('camera recording too short.');
    }
  } else {
    stopPreview();
    camRec = { start: performance.now() / 1000, buf: [], last: -1, at: Math.round(playheadT * 10) / 10 };
    timelineUI?.setRecording(true);
    log('recording camera — orbit / scroll / arrow keys to move, then Stop rec.');
  }
}

// Arrow-key camera navigation (when the director isn't driving the camera).
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (previewStart != null || render) return; // director owns the camera
  const s = e.shiftKey ? 0.25 : 0.08;
  switch (e.key) {
    case 'ArrowLeft': stage.nudgeCamera(-s, 0, 0); break;
    case 'ArrowRight': stage.nudgeCamera(s, 0, 0); break;
    case 'ArrowUp': stage.nudgeCamera(0, 0, s); break; // dolly in
    case 'ArrowDown': stage.nudgeCamera(0, 0, -s); break; // dolly out
    case 'PageUp': stage.nudgeCamera(0, s, 0); break; // pedestal up
    case 'PageDown': stage.nudgeCamera(0, -s, 0); break;
    default:
      return;
  }
  e.preventDefault();
});

log(`ready · avatar: ${avatar.description}`);

// Debug handle for inspecting the scene/camera from the console.
(window as unknown as { __las: unknown }).__las = { stage, avatar };
