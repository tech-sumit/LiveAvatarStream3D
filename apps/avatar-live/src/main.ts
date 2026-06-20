import { Stage, type Shot } from './scene/stage.js';
import { AvatarController } from './avatar/avatarController.js';
import { BoundaryLipsync } from './lipsync/boundaryLipsync.js';
import { AudioAnalyserLipsync } from './lipsync/audioLipsync.js';
import { WebSpeechTts } from './tts/webSpeech.js';
import { ServerTts } from './tts/serverTts.js';
import { RealtimeSession } from './session/realtimeSession.js';
import { Recorder } from './capture/recorder.js';
import { BlendshapeTimelineLipsync } from './lipsync/blendshapeTimeline.js';
import { LocalA2FClient } from './a2f/localA2F.js';
import { ServerA2FClient } from './a2f/serverA2F.js';
import type { A2FClient } from './a2f/types.js';
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
const glbUrlInput = $<HTMLInputElement>('glbUrl');
const loadUrlBtn = $<HTMLButtonElement>('loadUrl');
const recordBtn = $<HTMLButtonElement>('record');
const downloadEl = $<HTMLAnchorElement>('download');
const a2fDemoBtn = $<HTMLButtonElement>('a2fDemo');
const a2fAudioInput = $<HTMLInputElement>('a2fAudio');
const a2fModeEl = $<HTMLSpanElement>('a2fMode');
const statusEl = $<HTMLSpanElement>('avatarStatus');
const logEl = $<HTMLPreElement>('log');

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

// Shared loader for the default avatar, file uploads, and URL loads.
async function loadAvatar(url: string, label: string): Promise<boolean> {
  log(`loading ${label}…`);
  try {
    const res = await avatar.loadGltf(url);
    if (res.mode === 'none') {
      log(`⚠ ${label}: ${res.detail}. Use an ARKit/Oculus-blendshape avatar (e.g. Ready Player Me).`);
      return false;
    }
    stage.frame(avatar.headCenter, avatar.headHeight, shotSel.value as Shot);
    statusEl.textContent = avatar.description;
    log(`loaded ${label} — ${res.detail}`);
    if (res.mode === 'jawbone') log('note: jaw-bone lipsync is open/close only (no visemes/expression).');
    return true;
  } catch (err) {
    log(`failed to load ${label}: ${String(err)}`);
    return false;
  }
}

// Default avatar: a textured Ready Player Me human (from the MIT-licensed
// met4citizen/talkinghead repo) with full ARKit + Oculus viseme blendshapes.
// Falls back to the facecap head scan, then the procedural head.
void (async () => {
  if (await loadAvatar('/avatars/brunette.glb', 'Ready Player Me (brunette)')) return;
  if (await loadAvatar('/avatars/human.glb', 'realistic face (facecap)')) return;
  log('using procedural head.');
})();

// ── Lipsync state ────────────────────────────────────────────────────────────
const boundary = new BoundaryLipsync(Number(rateEl.value));
let analyser: AudioAnalyserLipsync | null = null;
let speaking = false;

// Audio2Face-3D playback state (full-face ARKit timeline driven by an audio clock).
const a2fUrl = import.meta.env.VITE_A2F_URL as string | undefined;
const a2fClient: A2FClient = a2fUrl ? new ServerA2FClient(a2fUrl) : new LocalA2FClient();
a2fModeEl.textContent = a2fClient.kind === 'server' ? 'NIM' : 'local stand-in';
let a2fCtx: AudioContext | null = null;
let a2fLip: BlendshapeTimelineLipsync | null = null;
let a2fSrc: AudioBufferSourceNode | null = null;
let a2fStart = 0;

stage.onFrame((dt) => {
  if (a2fLip && a2fCtx) {
    const t = a2fCtx.currentTime - a2fStart;
    avatar.setNamedFace(a2fLip.sampleAt(t));
  } else if (speaking) {
    avatar.setMouth(analyser ? analyser.sample() : boundary.sample(performance.now()));
  } else {
    avatar.setSilent();
  }
  avatar.update(dt);
});

function stopA2F(): void {
  try {
    a2fSrc?.stop();
  } catch {
    /* already stopped */
  }
  a2fSrc = null;
  a2fLip = null;
  avatar.setNamedFace(null);
}

// Analyze audio → ARKit blendshape timeline, then play audio + drive the face.
async function runA2F(buffer: AudioBuffer, label: string): Promise<void> {
  if (!avatar.supportsNamedFace) {
    log('⚠ current avatar has no blendshapes — A2F needs an ARKit/Oculus avatar.');
    return;
  }
  stopA2F();
  session.stop();
  log(`A2F (${a2fClient.kind}): analyzing ${label}…`);
  const timeline = await a2fClient.analyze(buffer);
  log(`A2F: ${timeline.frames.length} frames × ${timeline.names.length} shapes; playing…`);
  const ctx = (a2fCtx ??= new AudioContext());
  await ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  a2fLip = new BlendshapeTimelineLipsync(timeline);
  a2fStart = ctx.currentTime;
  a2fSrc = src;
  src.onended = () => {
    stopA2F();
    setSpeakingUi(false);
    log('A2F playback done.');
  };
  src.start();
  setSpeakingUi(true);
}

async function loadAndRunA2F(url: string, label: string): Promise<void> {
  try {
    const ctx = (a2fCtx ??= new AudioContext());
    const bytes = await (await fetch(url)).arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    await runA2F(buffer, label);
  } catch (err) {
    log(`A2F failed for ${label}: ${String(err)}`);
  }
}

// ── TTS source selection ─────────────────────────────────────────────────────
const serverTtsUrl = import.meta.env.VITE_TTS_URL as string | undefined;
let tts: TtsSource;
if (WebSpeechTts.supported()) {
  tts = new WebSpeechTts();
} else if (serverTtsUrl) {
  tts = new ServerTts(serverTtsUrl);
} else {
  tts = new WebSpeechTts(); // will report unsupported on use
  log('No TTS available: Web Speech unsupported and VITE_TTS_URL unset.');
}

void populateVoices();
async function populateVoices(): Promise<void> {
  if (!tts.listVoices) return;
  const voices = await tts.listVoices();
  voiceSel.innerHTML = '';
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    voiceSel.appendChild(opt);
  }
  // Prefer an English voice by default.
  const en = voices.find((v) => /en[-_]/i.test(v.id) || /English/i.test(v.label));
  if (en) voiceSel.value = en.id;
}

// ── Session ──────────────────────────────────────────────────────────────────
const session = new RealtimeSession(
  tts,
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
    onSegmentStart: () => {
      speaking = true;
    },
    onIdle: () => {
      speaking = false;
      analyser = null;
      log('idle');
      setSpeakingUi(false);
    },
    onStatus: (m) => log(m),
  },
);

// ── Controls ─────────────────────────────────────────────────────────────────
speakBtn.addEventListener('click', () => {
  boundary.setRate(Number(rateEl.value));
  session.start(scriptEl.value);
  setSpeakingUi(true);
});
stopBtn.addEventListener('click', () => {
  session.stop();
  stopA2F();
  speaking = false;
  analyser = null;
  setSpeakingUi(false);
  log('stopped (barge-in)');
});

a2fDemoBtn.addEventListener('click', () => void loadAndRunA2F('/audio/sample.wav', 'sample (Claire_neutral)'));
a2fAudioInput.addEventListener('change', () => {
  const file = a2fAudioInput.files?.[0];
  if (file) void loadAndRunA2F(URL.createObjectURL(file), file.name);
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

loadUrlBtn.addEventListener('click', () => {
  const url = glbUrlInput.value.trim();
  if (url) void loadAvatar(url, url.split('/').pop() || 'url');
});
glbUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadUrlBtn.click();
});

// ── Recording (virtual camera capture) ───────────────────────────────────────
const recorder = new Recorder(() => stage.captureStream(30));
recordBtn.addEventListener('click', async () => {
  if (!recorder.active) {
    recorder.start();
    recordBtn.textContent = '■ Stop recording';
    recordBtn.classList.add('rec');
    downloadEl.hidden = true;
    log('recording camera…');
  } else {
    const { url, filename } = await recorder.stop();
    recordBtn.textContent = '● Record camera';
    recordBtn.classList.remove('rec');
    if (url) {
      downloadEl.href = url;
      downloadEl.download = filename;
      downloadEl.hidden = false;
      log(`clip ready: ${filename} (video only — Web Speech audio isn't capturable)`);
    }
  }
});

function setSpeakingUi(on: boolean): void {
  speakBtn.disabled = on;
  stopBtn.disabled = !on;
}

log(`ready · TTS: ${tts.kind} · avatar: ${avatar.description}`);

// Debug handle for inspecting the scene/camera from the console.
(window as unknown as { __las: unknown }).__las = { stage, avatar };
