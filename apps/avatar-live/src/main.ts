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
import { CATALOG, poseToTuple } from './timeline/catalog.js';
import { cueId, type Cue, type PoseTuple, type Timeline } from './timeline/types.js';
import { r2Available, r2GetJson, r2List, r2PutBlob, r2PutJson, r2Url } from './storage/r2.js';
import type { EmotionName } from './avatar/emotion.js';
import type { TtsSource } from './tts/types.js';

// ── DOM ────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const appEl = $('app');
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
const lipGainEl = $<HTMLInputElement>('lipGain');
const lipJawEl = $<HTMLInputElement>('lipJaw');
const lipWideEl = $<HTMLInputElement>('lipWide');
const lipRoundEl = $<HTMLInputElement>('lipRound');
const lipSmoothEl = $<HTMLInputElement>('lipSmooth');
const lipTestBtn = $<HTMLButtonElement>('lipTest');
const lipSaveBtn = $<HTMLButtonElement>('lipSave');
const lipDimEl = $<HTMLDivElement>('lipDim');
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
const projectNameEl = $<HTMLInputElement>('projectName');
const saveTimelineBtn = $<HTMLButtonElement>('saveTimeline');
const loadTimelineBtn = $<HTMLButtonElement>('loadTimeline');
const savedListSel = $<HTMLSelectElement>('savedList');
const timelineFileEl = $<HTMLInputElement>('timelineFile');
const cueInspectorEl = $<HTMLDivElement>('cueInspector');
const cueTypeEl = $<HTMLDivElement>('cueType');
const cueStartEl = $<HTMLInputElement>('cueStart');
const cueDurEl = $<HTMLInputElement>('cueDur');
const cueSetViewBtn = $<HTMLButtonElement>('cueSetView');
const cueDeleteBtn = $<HTMLButtonElement>('cueDelete');
const cueAudioEl = $<HTMLDivElement>('cueAudio');
const cueVolEl = $<HTMLInputElement>('cueVol');
const cueFadeInEl = $<HTMLInputElement>('cueFadeIn');
const cueFadeOutEl = $<HTMLInputElement>('cueFadeOut');

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

// ── Avatar discovery (public/<id>-model/{model.glb,config.json}) ──────────────
// Folders are auto-indexed by the Vite avatar plugin (→ /avatars.json). Each
// avatar carries its own lip-sync config so "how much the lips move" is per-model.
interface AvatarConfig {
  id: string;
  label: string;
  description?: string;
  model: string; // filename inside the folder
  shot?: Shot;
  lipsync: { gain: number; jaw: number; wide: number; round: number; smoothing: number };
}
const DEFAULT_LIP = { gain: 1, jaw: 1, wide: 1, round: 1, smoothing: 0.2 };
const avatarConfigs = new Map<string, AvatarConfig>();
let currentAvatarId: string | null = null; // null = a file/URL-loaded avatar (not a folder)
let lipCfg = { ...DEFAULT_LIP }; // active lip-sync config (drives setLipsync + analyser smoothing)

async function discoverAvatars(): Promise<void> {
  let ids: string[] = [];
  try {
    ids = (await (await fetch('/avatars.json')).json()) as string[];
  } catch {
    ids = [];
  }
  avatarSel.innerHTML = '';
  for (const id of ids) {
    try {
      const c = (await (await fetch(`/${id}/config.json`)).json()) as Partial<AvatarConfig>;
      const cfg: AvatarConfig = {
        id,
        label: c.label || id,
        description: c.description,
        model: c.model || 'model.glb',
        shot: c.shot,
        lipsync: { ...DEFAULT_LIP, ...(c.lipsync || {}) },
      };
      avatarConfigs.set(id, cfg);
      const o = document.createElement('option');
      o.value = id;
      o.textContent = cfg.label;
      avatarSel.appendChild(o);
    } catch {
      /* skip a malformed avatar folder */
    }
  }
  log(`avatars: discovered ${avatarConfigs.size} (${[...avatarConfigs.keys()].join(', ') || 'none'})`);
}

// Reflect a lip-sync config into the active avatar + the calibration sliders.
function applyLipCfg(c: Partial<typeof DEFAULT_LIP>): void {
  lipCfg = { ...DEFAULT_LIP, ...c };
  avatar.setLipsync(lipCfg);
  lipGainEl.value = String(lipCfg.gain);
  lipJawEl.value = String(lipCfg.jaw);
  lipWideEl.value = String(lipCfg.wide);
  lipRoundEl.value = String(lipCfg.round);
  lipSmoothEl.value = String(lipCfg.smoothing);
}

async function loadAvatarById(id: string): Promise<boolean> {
  const cfg = avatarConfigs.get(id);
  if (!cfg) return false;
  if (cfg.shot) shotSel.value = cfg.shot;
  applyLipCfg(cfg.lipsync);
  const ok = await loadAvatar(`/${id}/${cfg.model}`, cfg.label);
  if (ok) {
    currentAvatarId = id;
    lipSaveBtn.disabled = false;
    lipDimEl.textContent = `calibrating ${cfg.label} — saves to ${id}/config.json`;
  }
  return ok;
}

void (async () => {
  await discoverAvatars();
  const ids = [...avatarConfigs.keys()];
  // Prefer the photoreal Avaturn anchor; else the first discovered avatar.
  const order = ['avaturn-model', ...ids.filter((i) => i !== 'avaturn-model')];
  for (const id of order) {
    if (avatarConfigs.has(id) && (await loadAvatarById(id))) {
      avatarSel.value = id;
      return;
    }
  }
  log('using procedural head — drop a blendshape GLB in public/<name>-model/model.glb.');
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

// Pre-generated narration: the whole script synthesized into one buffer + the
// per-sentence timeline. Built by "Generate", then played (preview) or recorded.
let narrationAudio: AudioBuffer | null = null;
let narrationSegs: { t: number; gesture: string; emotion?: string }[] = [];

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
  // Auto-align: softly keep the model's face centered at eye level. Active only
  // when the user owns the camera (not during preview/render or gizmo editing),
  // so orbit + zoom still work — the height/target just track the face.
  if (autoAlignOn && previewStart == null && !render && !gizmoOn) {
    stage.softAlignToFace(faceWorld());
  }

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
      timelineUI?.setPlayhead(t);
      player.update(t); // director camera (if any) + motion + screen cuts, synced
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

// A project loaded before the voice list finished populating stashes its voice
// here; populateVoices() applies it once the matching <option> exists.
let pendingVoiceId: string | null = null;
function voiceOptionExists(id: string): boolean {
  return [...voiceSel.options].some((o) => o.value === id);
}

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
  // Default voice: ElevenLabs → "Sarah"; Web Speech → an English voice.
  if (activeTts.kind === 'web-speech') {
    const en = voices.find((v) => /en[-_]/i.test(v.id) || /English/i.test(v.label));
    if (en) voiceSel.value = en.id;
  } else {
    const sarah = voices.find((v) => /\bsarah\b/i.test(v.label));
    if (sarah) voiceSel.value = sarah.id;
  }
  // Apply a voice from a project that loaded before the list was ready.
  if (pendingVoiceId && voiceOptionExists(pendingVoiceId)) {
    voiceSel.value = pendingVoiceId;
    pendingVoiceId = null;
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
      analyser = new AudioAnalyserLipsync(ctx, node, lipCfg.smoothing);
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
// Editing the script (or voice settings) invalidates pre-generated narration.
scriptEl.addEventListener('input', () => {
  narrationAudio = null;
});

resetViewBtn.addEventListener('click', () =>
  stage.frame(avatar.headCenter, avatar.headHeight, shotSel.value as Shot, true),
);
centerAvatarBtn.addEventListener('click', () => {
  avatar.setPosition(0, 0, 0);
  avatar.group.quaternion.identity();
  syncGizmoToAvatar();
});

// ── Align camera to the model's face ─────────────────────────────────────────
// World-space face center (head center offset by the avatar's position).
function faceWorld(): THREE.Vector3 {
  return avatar.headCenter.clone().add(avatar.group.position);
}
const alignFaceBtn = $<HTMLButtonElement>('alignFace');
const autoAlignBtn = $<HTMLButtonElement>('autoAlign');
let autoAlignOn = false;
alignFaceBtn.addEventListener('click', () => stage.alignToFace(faceWorld()));
autoAlignBtn.addEventListener('click', () => {
  autoAlignOn = !autoAlignOn;
  autoAlignBtn.textContent = `Auto-align: ${autoAlignOn ? 'On' : 'Off'}`;
  autoAlignBtn.classList.toggle('primary', autoAlignOn);
  if (autoAlignOn) stage.alignToFace(faceWorld()); // snap immediately, then keep aligned
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

// ── Back screen: play video on the wall + cast a tab/screen + camera source ───
// A single offscreen <video> drives the wall texture (and the optional output
// cut). Its audio is routed into the shared graph so it's heard + recorded.
const wallVideo = document.createElement('video');
wallVideo.playsInline = true;
wallVideo.crossOrigin = 'anonymous';
wallVideo.loop = false;
let wallAudioWired = false;
let castStream: MediaStream | null = null;
let castAudioNode: MediaStreamAudioSourceNode | null = null;
// What's on the wall, for project persistence (a live cast can't be persisted).
let backScreen: { kind: 'url' | 'r2' | 'file'; src: string; blob?: Blob } | null = null;

const screenUrlInput = $<HTMLInputElement>('screenUrl');
const screenLoadBtn = $<HTMLButtonElement>('screenLoad');
const screenFileInput = $<HTMLInputElement>('screenFile');
const screenCastBtn = $<HTMLButtonElement>('screenCast');
const screenStopBtn = $<HTMLButtonElement>('screenStop');
const camSourceBtn = $<HTMLButtonElement>('camSource');

function wireWallAudio(): void {
  if (wallAudioWired) return;
  const ctx = audioCtx();
  try {
    const src = ctx.createMediaElementSource(wallVideo);
    src.connect(ctx.destination);
    if (recordDest) src.connect(recordDest);
    wallAudioWired = true;
  } catch {
    /* already wired */
  }
}
function showOnWall(): void {
  studio.setScreenVideo(wallVideo);
  stage.setScreenSource(wallVideo);
  void wallVideo.play().catch((e) => log(`video play blocked: ${String(e)}`));
}
function stopCast(): void {
  castAudioNode?.disconnect();
  castAudioNode = null;
  castStream?.getTracks().forEach((t) => t.stop());
  castStream = null;
}
async function loadWallVideo(src: string, label: string): Promise<void> {
  stopCast();
  wireWallAudio();
  wallVideo.srcObject = null;
  wallVideo.src = src;
  wallVideo.muted = false;
  showOnWall();
  log(`back screen: playing ${label}.`);
}
screenLoadBtn.addEventListener('click', () => {
  const url = screenUrlInput.value.trim();
  if (!url) return;
  backScreen = { kind: 'url', src: url };
  void loadWallVideo(url, url.split('/').pop() || 'video');
});
screenUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') screenLoadBtn.click();
});
screenFileInput.addEventListener('change', () => {
  const file = screenFileInput.files?.[0];
  if (!file) return;
  const obj = URL.createObjectURL(file);
  backScreen = { kind: 'file', src: obj, blob: file };
  void loadWallVideo(obj, file.name);
  screenFileInput.value = '';
});
screenCastBtn.addEventListener('click', async () => {
  const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c: unknown) => Promise<MediaStream> };
  if (!md.getDisplayMedia) {
    log('casting needs a browser that supports screen capture (getDisplayMedia).');
    return;
  }
  try {
    stopCast();
    castStream = await md.getDisplayMedia({ video: true, audio: true });
    backScreen = null; // a live cast isn't persistable
    wireWallAudio();
    wallVideo.src = '';
    wallVideo.srcObject = castStream;
    // Mute the wall element (its tab is already audible locally → no echo), but tap
    // the cast stream's audio into the recording so the captured clip has it.
    wallVideo.muted = true;
    if (castStream.getAudioTracks().length && recordDest) {
      castAudioNode = audioCtx().createMediaStreamSource(castStream);
      castAudioNode.connect(recordDest);
    }
    showOnWall();
    castStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      log('cast ended.');
      revertScreen();
    });
    log('casting a tab/screen onto the wall.');
  } catch (err) {
    log(`cast cancelled: ${String(err)}`);
  }
});
function revertScreen(): void {
  stopCast();
  backScreen = null;
  wallVideo.pause();
  wallVideo.srcObject = null;
  wallVideo.src = '';
  studio.setScreenVideo(null);
  stage.setScreenSource(null); // also resets the output to 'scene'
  updateCamSourceLabel();
  log('back screen: headline restored.');
}
// The button always reflects the Stage's actual output source (single source of truth).
function updateCamSourceLabel(): void {
  const on = stage.outputIsScreen;
  camSourceBtn.textContent = `Camera source: ${on ? 'Screen' : 'Scene'}`;
  camSourceBtn.classList.toggle('primary', on);
}
screenStopBtn.addEventListener('click', revertScreen);
camSourceBtn.addEventListener('click', () => {
  if (!wallVideo.src && !wallVideo.srcObject) {
    log('load a video / cast first, then switch the camera to the screen.');
    return;
  }
  stage.setOutputSource(stage.outputIsScreen ? 'scene' : 'screen');
  updateCamSourceLabel();
});

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

// A file/URL-loaded avatar isn't a discovered folder, so it can't save config.
function loadAdHocAvatar(url: string, label: string): Promise<boolean> {
  currentAvatarId = null;
  lipSaveBtn.disabled = true;
  applyLipCfg(DEFAULT_LIP);
  return loadAvatar(url, label);
}
glbInput.addEventListener('change', async () => {
  const file = glbInput.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    await loadAdHocAvatar(url, file.name);
  } finally {
    URL.revokeObjectURL(url);
  }
});

avatarSel.addEventListener('change', () => {
  void loadAvatarById(avatarSel.value);
});

loadUrlBtn.addEventListener('click', () => {
  const url = glbUrlInput.value.trim();
  if (url) void loadAdHocAvatar(url, url.split('/').pop() || 'url');
});
glbUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadUrlBtn.click();
});

// ── Lip-sync calibration ─────────────────────────────────────────────────────
function readLipSliders(): typeof DEFAULT_LIP {
  return {
    gain: Number(lipGainEl.value),
    jaw: Number(lipJawEl.value),
    wide: Number(lipWideEl.value),
    round: Number(lipRoundEl.value),
    smoothing: Number(lipSmoothEl.value),
  };
}
function onLipSlider(): void {
  lipCfg = readLipSliders();
  avatar.setLipsync(lipCfg); // gain/jaw/wide/round apply live; smoothing on next utterance
}
[lipGainEl, lipJawEl, lipWideEl, lipRoundEl, lipSmoothEl].forEach((el) => el.addEventListener('input', onLipSlider));
lipTestBtn.addEventListener('click', () => {
  audioCtx();
  session.start('Lip sync calibration test. Watch how much the lips are moving as I speak.');
  setSpeakingUi(true);
});
lipSaveBtn.addEventListener('click', async () => {
  if (!currentAvatarId) {
    log('select a discovered avatar (not a file/URL load) to save its lip-sync config.');
    return;
  }
  const cfg = avatarConfigs.get(currentAvatarId);
  if (!cfg) return;
  cfg.lipsync = readLipSliders();
  const doc = { label: cfg.label, description: cfg.description, model: cfg.model, shot: cfg.shot, lipsync: cfg.lipsync };
  try {
    const r = await fetch(`/avatar-config/${currentAvatarId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(doc),
    });
    log(r.ok ? `saved lip-sync config → ${currentAvatarId}/config.json` : `save failed (${r.status})`);
  } catch (err) {
    log(`save failed: ${String(err)}`);
  }
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

// Synthesize the whole script into one buffer + per-sentence timeline, and lay
// the sentences onto the Narration lane (timing comes from the real audio).
async function buildNarration(): Promise<boolean> {
  if (!activeTts.synthesize) {
    log('narration needs ElevenLabs — add ELEVENLABS_API_KEY to apps/avatar-live/.env.');
    return false;
  }
  const lines = scriptEl.value
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) {
    log('nothing to generate — script is empty.');
    return false;
  }
  const segs = lines.map(resolveGesture);
  const ctx = audioCtx();
  await ctx.resume();
  log(`narration: synthesizing ${segs.length} sentence(s)…`);
  let buffers: AudioBuffer[];
  try {
    // Sentences are independent → synthesize in parallel (≈one round-trip, not N).
    buffers = await Promise.all(segs.map((s) => activeTts.synthesize!(s.text, ttsOpts())));
  } catch (err) {
    log(`narration failed (TTS): ${String(err)}`);
    return false;
  }

  // Concatenate into one buffer (short gap between sentences) + timeline + cues.
  const sr = buffers[0].sampleRate;
  const gap = Math.round(sr * 0.18);
  const total = buffers.reduce((a, b) => a + b.length + gap, 0);
  const out = ctx.createBuffer(1, total, sr);
  const od = out.getChannelData(0);
  const segTimeline: { t: number; gesture: string; emotion?: string }[] = [];
  const cues: Cue[] = [];
  let off = 0;
  buffers.forEach((b, i) => {
    od.set(monoData(b), off);
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

  narrationAudio = out;
  narrationSegs = segTimeline;
  // Replace any existing narration cues; extend the timeline to cover the audio.
  timeline.cues = timeline.cues.filter((c) => c.track !== 'narration').concat(cues);
  timeline.duration = Math.max(timeline.duration, Math.ceil(total / sr) + 1);
  player.load(timeline);
  timelineUI?.reload();
  log(`narration ready · ${(total / sr).toFixed(1)}s, ${cues.length} sentence(s). Preview to play it.`);
  return true;
}

async function generateNarration(): Promise<void> {
  const gen = document.getElementById('tlGen') as HTMLButtonElement | null;
  if (gen) gen.disabled = true;
  try {
    await buildNarration();
  } finally {
    if (gen) gen.disabled = false;
  }
}

// Unified performance: play the pre-generated narration once while driving
// lipsync + motion + camera off the audio clock. record=true also captures it to
// a downloadable clip; record=false is an in-editor preview.
let performing = false; // guards against re-entry while synthesizing / playing
async function perform(record: boolean): Promise<void> {
  if (performing) return;
  performing = true;
  session.stop();
  if (!narrationAudio) {
    if (!(await buildNarration())) {
      performing = false;
      return;
    }
  }
  const ctx = audioCtx();
  await ctx.resume();
  const out = narrationAudio!;

  // Audio graph: narration → gain → speakers + record destination + analyser.
  const srcNode = ctx.createBufferSource();
  srcNode.buffer = out;
  const gain = ctx.createGain();
  srcNode.connect(gain);
  gain.connect(ctx.destination);
  if (recordDest) gain.connect(recordDest);
  const ana = new AudioAnalyserLipsync(ctx, gain, lipCfg.smoothing);

  if (record) {
    try {
      recorder.start();
    } catch (err) {
      log(`record start failed: ${String(err)}`);
      performing = false;
      return;
    }
    setRecUi(true);
    downloadEl.hidden = true;
  }

  const startAt = ctx.currentTime + 0.12;
  renderSrc = srcNode;
  render = { ctx, start: startAt, analyser: ana, timeline: narrationSegs, idx: -1 };
  player.begin(); // drives camera (if framing cues) + motion + screen cuts off the clock
  scheduleAudioCues(ctx, startAt); // background-music / SFX clips, mixed + captured
  timelineUI?.setPlaying(!record);
  log(
    record
      ? `render: recording ${stage.captureLabel()} · ${(out.length / out.sampleRate).toFixed(1)}s …`
      : `playing narration · ${(out.length / out.sampleRate).toFixed(1)}s …`,
  );

  srcNode.onended = async () => {
    render = null;
    renderSrc = null;
    player.end();
    stopAudioCues();
    avatar.setSilent();
    avatar.setGazeTarget(null);
    if (avatar.animationClips.length) avatar.playClip('idle');
    timelineUI?.setPlaying(false);
    timelineUI?.setPlayhead(0);
    performing = false;
    if (record) {
      const { url, filename } = await recorder.stop();
      setRecUi(false);
      downloadClip(url, filename);
    } else {
      log('narration playback finished.');
    }
  };
  srcNode.start(startAt);
}

/** Stop an in-progress perform() (preview or record) — onended does the cleanup. */
function stopPerform(): void {
  try {
    renderSrc?.stop();
  } catch {
    /* already stopped */
  }
}

// ── Background audio lane (music / SFX with volume + fade envelopes) ──────────
const audioBuffers = new Map<string, AudioBuffer>(); // cue.id → decoded buffer
const audioBlobs = new Map<string, Blob>(); // cue.id → original bytes (for R2 upload)
let scheduledAudio: AudioBufferSourceNode[] = [];
const audioFileEl = $<HTMLInputElement>('audioFile');

// Drop decoded buffers / blobs for audio cues that no longer exist (e.g. deleted).
function pruneAudioMaps(): void {
  const ids = new Set(timeline.cues.filter((c) => c.track === 'audio').map((c) => c.id));
  for (const id of [...audioBuffers.keys()]) if (!ids.has(id)) audioBuffers.delete(id);
  for (const id of [...audioBlobs.keys()]) if (!ids.has(id)) audioBlobs.delete(id);
}

// "+ Audio": pick a file, decode it, drop a clip on the Audio lane at the playhead.
function addAudioClip(): void {
  audioFileEl.click();
}
audioFileEl.addEventListener('change', async () => {
  const file = audioFileEl.files?.[0];
  audioFileEl.value = '';
  if (!file) return;
  try {
    const ctx = audioCtx();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const id = cueId();
    audioBuffers.set(id, buf);
    audioBlobs.set(id, file);
    const start = Math.round(playheadT * 10) / 10;
    const duration = Math.round(buf.duration * 10) / 10;
    timeline.cues.push({
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
    // Extend the timeline to cover a clip that runs past the current end.
    timeline.duration = Math.max(timeline.duration, Math.ceil(start + duration) + 1);
    player.load(timeline);
    timelineUI?.reload();
    log(`added audio "${file.name}" (${buf.duration.toFixed(1)}s) @ ${playheadT.toFixed(1)}s.`);
  } catch (err) {
    log(`couldn't load audio: ${String(err)}`);
  }
});

// Schedule every audio cue against the performance clock with a gain envelope
// (fade in / out), mixed into both the speakers and the recording.
function scheduleAudioCues(ctx: AudioContext, startAt: number): void {
  for (const c of timeline.cues) {
    if (c.track !== 'audio') continue;
    const buf = audioBuffers.get(c.id);
    if (!buf) continue; // file not loaded this session (e.g. after a reload)
    const vol = c.volume ?? 0.8;
    const len = Math.min(buf.duration, c.duration);
    const t0 = startAt + c.start;
    const tEnd = t0 + len;
    // Clamp the fades so fade-in then fade-out fit inside the clip (no overlap /
    // events scheduled past the stop time → no clicks).
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
    if (recordDest) gain.connect(recordDest);

    const g = gain.gain;
    g.setValueAtTime(fi > 0 ? 0.0001 : vol, t0);
    if (fi > 0) g.linearRampToValueAtTime(vol, t0 + fi);
    if (fo > 0) {
      g.setValueAtTime(vol, tEnd - fo); // tEnd-fo >= t0+fi after clamping
      g.linearRampToValueAtTime(0.0001, tEnd);
    }
    src.start(t0, 0, len);
    scheduledAudio.push(src);
  }
}
function stopAudioCues(): void {
  for (const s of scheduledAudio) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  scheduledAudio = [];
}

recordBtn.addEventListener('click', () => {
  if (render) {
    stopPerform(); // ends early → onended exports what's captured (if recording)
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
    void perform(true);
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
function buildTimelineUI(): void {
  if (timelineUI) return;
  timelineUI = new TimelineUI(timelineEl, timeline, {
    onChange: () => {
      player.load(timeline);
      pruneAudioMaps(); // free buffers/blobs for deleted audio cues
    },
    onPreview: togglePreview,
    onStop: stopPreview,
    onSeek: seekPreview,
    onCapturePose: captureCameraCue,
    onRecordPath: toggleCameraRecord,
    onSelect: showCueInspector,
    onGenerate: () => void generateNarration(),
    onAddAudio: addAudioClip,
  });
}
timelineToggle.addEventListener('click', () => {
  const open = appEl.classList.toggle('tl-open'); // grid row expands; Stage's ResizeObserver resizes
  if (open) buildTimelineUI();
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
  if (render) {
    stopPerform(); // narration playback in progress → stop
    return;
  }
  if (previewStart != null) {
    stopPreview();
    return;
  }
  // If narration is generated, Preview plays it lip-synced; otherwise it's a
  // silent camera/motion rehearsal.
  if (narrationAudio) void perform(false);
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

// ── Cue inspector (right panel) — precise editing of the selected cue ─────────
let selectedCue: Cue | null = null;
function showCueInspector(cue: Cue | null): void {
  selectedCue = cue;
  cueInspectorEl.hidden = !cue;
  if (!cue) return;
  const name = cue.track === 'audio' ? (cue.label ?? 'audio') : cue.track === 'narration' ? (cue.text ?? '') : CATALOG[cue.type]?.label ?? cue.type;
  cueTypeEl.textContent = `${cue.track} · ${name}`;
  cueStartEl.value = cue.start.toFixed(1);
  cueDurEl.value = cue.duration.toFixed(1);
  // Narration timing is owned by the synthesized audio — its blocks are read-only.
  const ro = cue.track === 'narration';
  cueStartEl.disabled = ro;
  cueDurEl.disabled = ro;
  // "Set to current view" only makes sense for posed framing cues (not preset /
  // path / the screen-source cut).
  cueSetViewBtn.hidden = cue.track !== 'camera' || !!cue.path || cue.type === 'cam.screenSource';
  // Audio-only fields (volume + fade envelope).
  cueAudioEl.hidden = cue.track !== 'audio';
  if (cue.track === 'audio') {
    cueVolEl.value = String(cue.volume ?? 0.8);
    cueFadeInEl.value = String(cue.fadeIn ?? 0);
    cueFadeOutEl.value = String(cue.fadeOut ?? 1);
  }
}
function commitCueEdit(): void {
  if (!selectedCue || selectedCue.track === 'narration') return; // narration is read-only
  selectedCue.start = Math.max(0, Number(cueStartEl.value) || 0);
  selectedCue.duration = Math.max(0.1, Number(cueDurEl.value) || 0.1);
  player.load(timeline);
  timelineUI?.refresh();
}
cueStartEl.addEventListener('input', commitCueEdit);
cueDurEl.addEventListener('input', commitCueEdit);
function commitAudioEdit(): void {
  if (!selectedCue || selectedCue.track !== 'audio') return;
  selectedCue.volume = Math.max(0, Math.min(1, Number(cueVolEl.value)));
  selectedCue.fadeIn = Math.max(0, Number(cueFadeInEl.value) || 0);
  selectedCue.fadeOut = Math.max(0, Number(cueFadeOutEl.value) || 0);
}
[cueVolEl, cueFadeInEl, cueFadeOutEl].forEach((el) => el.addEventListener('input', commitAudioEdit));
cueSetViewBtn.addEventListener('click', () => {
  if (!selectedCue || selectedCue.track !== 'camera' || selectedCue.type === 'cam.screenSource') return;
  selectedCue.pose = poseToTuple(stage.getCameraPose());
  selectedCue.type = 'cam.custom';
  player.load(timeline);
  timelineUI?.refresh();
  showCueInspector(selectedCue);
  log('cue set to the current camera view.');
});
cueDeleteBtn.addEventListener('click', () => {
  if (selectedCue) timelineUI?.removeCue(selectedCue.id);
});

// ── Project save / load (Cloudflare R2; localStorage fallback) ───────────────
// A project bundles the editor state + the director timeline; audio/video assets
// are uploaded to R2 and referenced by key so they survive a reload. When R2
// isn't configured, state+timeline persist to localStorage (assets are not).
interface ProjectDoc {
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
  backScreen: { kind: 'url' | 'r2'; src: string } | null;
  timeline: { duration: number; cues: Cue[] };
}
const PROJECT_PREFIX = 'projects/';
const LOCAL_INDEX = 'las.projects';
const SAMPLE_VALUE = '__sample:showcase';
const SAMPLE_URL = '/samples/showcase.project.json';
const sanitize = (n: string) => (n.trim() || 'untitled').replace(/[^\w.-]+/g, '_');
let r2On = false;

// An asset reference is either a direct URL / bundled path (starts with http or
// "/") or an R2 object key. Resolve it to a fetchable same-origin URL.
function assetUrl(src: string): string {
  return /^https?:\/\//.test(src) || src.startsWith('/') ? src : r2Url(src);
}
async function fetchAssetBlob(src: string): Promise<Blob> {
  const r = await fetch(assetUrl(src));
  if (!r.ok) throw new Error(`asset ${r.status}`);
  return r.blob();
}

function listLocal(): string[] {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_INDEX) || '[]') as string[];
  } catch {
    return [];
  }
}
async function refreshSavedList(): Promise<void> {
  let names: string[] = [];
  if (r2On) {
    try {
      names = (await r2List(PROJECT_PREFIX)).filter((k) => k.endsWith('.json')).map((k) => k.slice(PROJECT_PREFIX.length, -5));
    } catch {
      names = [];
    }
  } else {
    names = listLocal();
  }
  savedListSel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = names.length ? `— load saved (${r2On ? 'R2' : 'local'}) —` : `(none saved · ${r2On ? 'R2' : 'local'})`;
  savedListSel.appendChild(def);
  // Always offer the bundled showcase sample (ships with the app, no R2 needed).
  const sample = document.createElement('option');
  sample.value = SAMPLE_VALUE;
  sample.textContent = '★ Showcase (sample)';
  savedListSel.appendChild(sample);
  for (const n of names.sort()) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    savedListSel.appendChild(o);
  }
}

// Load the bundled showcase sample from /public.
async function loadSample(): Promise<void> {
  try {
    const r = await fetch(SAMPLE_URL);
    if (!r.ok) throw new Error(`${r.status}`);
    await applyProject((await r.json()) as ProjectDoc);
    projectNameEl.value = 'showcase';
    log('loaded the bundled showcase sample — click 🎙 Generate to synthesize narration.');
  } catch (err) {
    log(`couldn't load sample: ${String(err)}`);
  }
}

function serializeProject(name: string): ProjectDoc {
  const bs = backScreen && backScreen.kind !== 'file' ? { kind: backScreen.kind, src: backScreen.src } : null;
  return {
    version: 2,
    name,
    script: scriptEl.value,
    voiceId: voiceSel.value,
    rate: Number(rateEl.value),
    pitch: Number(pitchEl.value),
    emotion: emotionSel.value,
    avatarUrl: currentAvatarId ?? '', // store the discovered-avatar id (empty for ad-hoc loads)
    shot: shotSel.value,
    studioOn,
    idleMotion: idleMotionOn,
    headline: headlineInput.value,
    lights: {
      key: Number(lightKey.value),
      fill: Number(lightFill.value),
      rim: Number(lightRim.value),
      ambient: Number(lightAmbient.value),
      exposure: Number(exposureEl.value),
      warmth: Number(warmthEl.value),
      preset: lightPresetSel.value,
    },
    backScreen: bs,
    timeline: { duration: timeline.duration, cues: timeline.cues },
  };
}

// Upload any session-only assets (audio clips, a back-screen file) to R2 and
// rewrite their references to R2 keys so the saved project is self-contained.
// Keys are project-independent (random ids) so renaming/duplicating a project
// never strands or overwrites an asset, and an already-uploaded asset (c.src set)
// is reused as-is. Uploads run in parallel.
async function uploadAssets(): Promise<void> {
  if (!r2On) return;
  const jobs: Promise<void>[] = [];
  for (const c of timeline.cues) {
    if (c.track !== 'audio' || c.src) continue;
    const blob = audioBlobs.get(c.id);
    if (!blob) continue;
    const key = `assets/${crypto.randomUUID()}-${sanitize(c.label ?? 'audio')}`;
    jobs.push(
      r2PutBlob(key, blob).then(() => {
        c.src = key;
      }),
    );
  }
  if (backScreen?.kind === 'file' && backScreen.blob) {
    const ext = (backScreen.blob.type.split('/')[1] || 'mp4').replace(/[^\w]+/g, '');
    const blob = backScreen.blob;
    const key = `assets/${crypto.randomUUID()}-backscreen.${ext}`;
    jobs.push(
      r2PutBlob(key, blob).then(() => {
        backScreen = { kind: 'r2', src: key };
      }),
    );
  }
  await Promise.all(jobs);
}

function downloadJson(filename: string, obj: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  downloadEl.href = url;
  downloadEl.download = filename;
  downloadEl.textContent = `⬇ ${filename}`;
  downloadEl.hidden = false;
  downloadEl.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function saveProject(): Promise<void> {
  const name = sanitize(projectNameEl.value);
  saveTimelineBtn.disabled = true;
  try {
    await uploadAssets();
    const doc = serializeProject(name);
    if (r2On) {
      await r2PutJson(`${PROJECT_PREFIX}${name}.json`, doc);
      await refreshSavedList();
      log(`saved project "${name}" to R2 (state + timeline + assets).`);
    } else {
      localStorage.setItem(`las.project.${name}`, JSON.stringify(doc));
      const idx = listLocal();
      if (!idx.includes(name)) idx.push(name);
      localStorage.setItem(LOCAL_INDEX, JSON.stringify(idx));
      await refreshSavedList();
      log(`saved project "${name}" locally (R2 off — assets not persisted).`);
    }
    savedListSel.value = name;
    downloadJson(`${name}.project.json`, doc);
  } catch (err) {
    log(`save failed: ${String(err)}`);
  } finally {
    saveTimelineBtn.disabled = false;
  }
}

// Apply just the timeline portion (fresh cue ids), reusing it for raw timeline files.
function applyTimelineDoc(data: { duration?: number; cues?: Cue[] } | null | undefined): void {
  const cues = Array.isArray(data?.cues) ? data.cues : [];
  timeline.duration = Math.max(2, Number(data?.duration) || 26);
  timeline.cues = cues.map((c) => ({ ...c, id: cueId() }));
  player.load(timeline);
  pruneAudioMaps();
  buildTimelineUI();
  timelineUI?.reload();
  if (!appEl.classList.contains('tl-open')) {
    appEl.classList.add('tl-open');
    timelineToggle.classList.add('primary');
  }
}

async function applyProject(doc: ProjectDoc): Promise<void> {
  scriptEl.value = doc.script ?? scriptEl.value;
  narrationAudio = null;
  rateEl.value = String(doc.rate ?? 1);
  pitchEl.value = String(doc.pitch ?? 1);
  boundary.setRate(Number(rateEl.value));
  emotionSel.value = doc.emotion ?? 'neutral';
  avatar.setEmotion(emotionSel.value as EmotionName);
  shotSel.value = doc.shot ?? 'medium';
  // The voice list may still be loading; defer if its option isn't there yet.
  if (doc.voiceId) {
    if (voiceOptionExists(doc.voiceId)) voiceSel.value = doc.voiceId;
    else pendingVoiceId = doc.voiceId;
  }

  if (doc.lights) {
    lightKey.value = String(doc.lights.key);
    lightFill.value = String(doc.lights.fill);
    lightRim.value = String(doc.lights.rim);
    lightAmbient.value = String(doc.lights.ambient);
    exposureEl.value = String(doc.lights.exposure);
    warmthEl.value = String(doc.lights.warmth);
    lightPresetSel.value = doc.lights.preset ?? 'studio';
    applyLights();
  }
  studioOn = doc.studioOn ?? true;
  studio.group.visible = studioOn;
  studioToggle.textContent = `Studio: ${studioOn ? 'On' : 'Off'}`;
  studioToggle.classList.toggle('primary', studioOn);
  idleMotionOn = doc.idleMotion ?? false;
  avatar.setIdleMotion(idleMotionOn);
  idleMotionToggle.textContent = `Idle motion: ${idleMotionOn ? 'On' : 'Off'}`;
  idleMotionToggle.classList.toggle('primary', idleMotionOn);
  if (doc.headline) {
    headlineInput.value = doc.headline;
    studio.setHeadline(doc.headline);
  }
  // Restore the avatar: a discovered-avatar id (preferred) or a raw path/URL.
  if (doc.avatarUrl) {
    if (avatarConfigs.has(doc.avatarUrl)) {
      if (doc.avatarUrl !== currentAvatarId) {
        avatarSel.value = doc.avatarUrl;
        await loadAvatarById(doc.avatarUrl);
      }
    } else if (/^(https?:|\/)/.test(doc.avatarUrl)) {
      await loadAdHocAvatar(doc.avatarUrl, doc.avatarUrl.split('/').pop() || 'avatar');
    }
  }

  applyTimelineDoc(doc.timeline);

  // Re-fetch + decode audio assets in parallel (cue ids were regenerated above).
  await Promise.all(
    timeline.cues
      .filter((c) => c.track === 'audio' && c.src)
      .map(async (c) => {
        try {
          const blob = await fetchAssetBlob(c.src!);
          audioBlobs.set(c.id, blob);
          audioBuffers.set(c.id, await audioCtx().decodeAudioData(await blob.arrayBuffer()));
        } catch {
          log(`audio asset missing: ${c.src}`);
        }
      }),
  );
  // Restore the back-screen video.
  revertScreen();
  if (doc.backScreen) {
    const src = doc.backScreen.kind === 'r2' ? r2Url(doc.backScreen.src) : doc.backScreen.src;
    backScreen = { kind: doc.backScreen.kind, src: doc.backScreen.src };
    void loadWallVideo(src, 'back screen');
  }
  log(`loaded project "${doc.name}" — ${timeline.cues.length} cue(s).`);
}

async function loadNamed(name: string): Promise<void> {
  try {
    let doc: ProjectDoc;
    if (r2On) {
      doc = await r2GetJson<ProjectDoc>(`${PROJECT_PREFIX}${name}.json`);
    } else {
      const json = localStorage.getItem(`las.project.${name}`);
      if (!json) throw new Error('not found');
      doc = JSON.parse(json) as ProjectDoc;
    }
    await applyProject(doc);
    projectNameEl.value = name;
  } catch (err) {
    log(`load "${name}" failed: ${String(err)}`);
    void refreshSavedList();
  }
}

saveTimelineBtn.addEventListener('click', () => void saveProject());
loadTimelineBtn.addEventListener('click', () => timelineFileEl.click());
timelineFileEl.addEventListener('change', async () => {
  const file = timelineFileEl.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const isObj = data && typeof data === 'object';
    const isProject = isObj && (typeof data.script === 'string' || (data.timeline && typeof data.timeline === 'object'));
    const isTimeline = isObj && Array.isArray(data.cues);
    if (isProject) {
      await applyProject(data as ProjectDoc); // full project file
      projectNameEl.value = file.name.replace(/\.(project|timeline)\.json$|\.json$/i, '');
    } else if (isTimeline) {
      applyTimelineDoc(data); // raw timeline file
      log(`loaded timeline — ${timeline.cues.length} cue(s).`);
    } else {
      log('load failed: unrecognized file.');
    }
  } catch (err) {
    log(`load failed: ${String(err)}`);
  }
  timelineFileEl.value = '';
});
savedListSel.addEventListener('change', () => {
  if (savedListSel.value === SAMPLE_VALUE) void loadSample();
  else if (savedListSel.value) void loadNamed(savedListSel.value);
});

// Probe R2 once; populate the saved-projects list from wherever persistence lives.
void (async () => {
  r2On = await r2Available();
  log(r2On ? 'persistence: Cloudflare R2.' : 'persistence: browser localStorage (set R2_* in .env for R2).');
  await refreshSavedList();
})();

log(`ready · avatar: ${avatar.description}`);

// Debug handle for inspecting the scene/camera from the console.
(window as unknown as { __las: unknown }).__las = { stage, avatar, studio, wallVideo };
