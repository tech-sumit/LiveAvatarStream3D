import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Stage, type Shot } from './scene/stage.js';
import { AvatarController } from './avatar/avatarController.js';
import { BoundaryLipsync } from './lipsync/boundaryLipsync.js';
import { AudioAnalyserLipsync } from './lipsync/audioLipsync.js';
import { WebSpeechTts } from './tts/webSpeech.js';
import { ServerTts } from './tts/serverTts.js';
import { ElevenLabsTts } from './tts/elevenLabs.js';
import { RealtimeSession } from './session/realtimeSession.js';
import { Recorder } from './capture/recorder.js';
import { resolveGesture, selectTalkClip, type Gesture } from './avatar/gestures.js';
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
const posX = $<HTMLInputElement>('posX');
const posY = $<HTMLInputElement>('posY');
const posZ = $<HTMLInputElement>('posZ');
const resetViewBtn = $<HTMLButtonElement>('resetView');
const centerAvatarBtn = $<HTMLButtonElement>('centerAvatar');
const gizmoBtn = $<HTMLButtonElement>('gizmoBtn');
const loadUrlBtn = $<HTMLButtonElement>('loadUrl');
const recordBtn = $<HTMLButtonElement>('record');
const downloadEl = $<HTMLAnchorElement>('download');
const statusEl = $<HTMLSpanElement>('avatarStatus');
const logEl = $<HTMLPreElement>('log');
const pipFrameEl = $<HTMLDivElement>('pipFrame');
const captureFormatSel = $<HTMLSelectElement>('captureFormat');
const gateLabelEl = $<HTMLSpanElement>('gateLabel');

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = `[${ts}] ${msg}\n${logEl.textContent ?? ''}`.slice(0, 4000);
}

// ── Scene + avatar ───────────────────────────────────────────────────────────
const stage = new Stage(stageEl);
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
    posX.value = posY.value = posZ.value = '0';
    avatar.setPosition(0, 0, 0);
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

stage.onFrame((dt) => {
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
  () => ({ voiceId: voiceSel.value || undefined, rate: Number(rateEl.value), pitch: Number(pitchEl.value) }),
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
    onSegmentStart: (_text, gesture) => {
      speaking = true;
      if (avatar.animationClips.length) {
        lastTalkClip = selectTalkClip(
          (gesture as Gesture) ?? 'explain',
          emotionSel.value as EmotionName,
          lastTalkClip,
        );
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

// Avatar position (X/Y/Z) + camera resets.
const applyPos = () => avatar.setPosition(Number(posX.value), Number(posY.value), Number(posZ.value));
[posX, posY, posZ].forEach((el) => el.addEventListener('input', applyPos));
resetViewBtn.addEventListener('click', () =>
  stage.frame(avatar.headCenter, avatar.headHeight, shotSel.value as Shot, true),
);
centerAvatarBtn.addEventListener('click', () => {
  posX.value = posY.value = posZ.value = '0';
  applyPos();
  syncGizmoToAvatar();
});

// TransformControls gizmo — drag the avatar directly in 3D. The handle sits at a
// proxy placed at chest height (the avatar's own origin is at the feet, off-
// screen); dragging the proxy translates the avatar by the same delta. Disables
// orbit while dragging and keeps the X/Y/Z sliders in sync.
const gizmoProxy = new THREE.Object3D();
stage.add(gizmoProxy);
let chestY = 1.15;
function syncGizmoToAvatar(): void {
  chestY = Math.max(0.5, avatar.headCenter.y - 0.45); // upper chest — clear of the face
  gizmoProxy.position.set(avatar.group.position.x, avatar.group.position.y + chestY, avatar.group.position.z);
}

const gizmo = new TransformControls(stage.camera, stage.renderer.domElement);
gizmo.setMode('translate');
gizmo.setSpace('world');
gizmo.setSize(1.8);
gizmo.attach(gizmoProxy);
gizmo.visible = false;
gizmo.enabled = false;
stage.add(gizmo);
gizmo.addEventListener('dragging-changed', (e) => {
  stage.controls.enabled = !(e as unknown as { value: boolean }).value;
});
gizmo.addEventListener('objectChange', () => {
  avatar.setPosition(gizmoProxy.position.x, gizmoProxy.position.y - chestY, gizmoProxy.position.z);
  posX.value = avatar.group.position.x.toFixed(2);
  posY.value = avatar.group.position.y.toFixed(2);
  posZ.value = avatar.group.position.z.toFixed(2);
});
stage.excludeFromCapture(gizmo); // keep the XYZ handles out of the recorded output
let gizmoOn = false;
gizmoBtn.addEventListener('click', () => {
  gizmoOn = !gizmoOn;
  if (gizmoOn) syncGizmoToAvatar();
  gizmo.visible = gizmoOn;
  gizmo.enabled = gizmoOn;
  gizmoBtn.classList.toggle('primary', gizmoOn);
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

// ── Recording — captures the virtual camera's output canvas at the set capture
// resolution + the voice (when using ElevenLabs/Web Audio). The editor stays
// fully interactive during recording.
const recorder = new Recorder(
  () => stage.captureStream(30),
  () => recordDest?.stream.getAudioTracks()[0] ?? null,
);
recordBtn.addEventListener('click', async () => {
  if (!recorder.active) {
    audioCtx(); // ensure the voice destination track exists before capture starts
    try {
      recorder.start();
    } catch (err) {
      log(`recording failed to start: ${String(err)}`);
      return;
    }
    recordBtn.textContent = '■ Stop recording';
    recordBtn.classList.add('rec');
    pipFrameEl.classList.add('rec');
    downloadEl.hidden = true;
    log(`recording ${stage.captureLabel()} (with voice) …`);
  } else {
    const { url, filename } = await recorder.stop();
    recordBtn.textContent = '● Record camera';
    recordBtn.classList.remove('rec');
    pipFrameEl.classList.remove('rec');
    if (url) {
      downloadEl.href = url;
      downloadEl.download = filename;
      downloadEl.textContent = `⬇ Download ${filename}`;
      downloadEl.hidden = false;
      downloadEl.click(); // download straight from the portal
      log(`clip ready — downloading ${filename}`);
    }
  }
});

function setSpeakingUi(on: boolean): void {
  speakBtn.disabled = on;
  stopBtn.disabled = !on;
}

log(`ready · avatar: ${avatar.description}`);

// Debug handle for inspecting the scene/camera from the console.
(window as unknown as { __las: unknown }).__las = { stage, avatar };
