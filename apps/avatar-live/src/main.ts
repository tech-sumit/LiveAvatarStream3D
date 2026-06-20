import { Stage, type Shot } from './scene/stage.js';
import { AvatarController } from './avatar/avatarController.js';
import { BoundaryLipsync } from './lipsync/boundaryLipsync.js';
import { AudioAnalyserLipsync } from './lipsync/audioLipsync.js';
import { WebSpeechTts } from './tts/webSpeech.js';
import { ServerTts } from './tts/serverTts.js';
import { RealtimeSession } from './session/realtimeSession.js';
import { Recorder } from './capture/recorder.js';
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
const recordBtn = $<HTMLButtonElement>('record');
const downloadEl = $<HTMLAnchorElement>('download');
const statusEl = $<HTMLSpanElement>('avatarStatus');
const logEl = $<HTMLPreElement>('log');

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = `[${ts}] ${msg}\n${logEl.textContent ?? ''}`.slice(0, 4000);
}

// ── Scene + avatar ───────────────────────────────────────────────────────────
const stage = new Stage(stageEl);
const avatar = new AvatarController();
stage.add(avatar.group);
stage.frame(avatar.headCenter, shotSel.value as Shot);
statusEl.textContent = avatar.description;

// ── Lipsync state ────────────────────────────────────────────────────────────
const boundary = new BoundaryLipsync(Number(rateEl.value));
let analyser: AudioAnalyserLipsync | null = null;
let speaking = false;

stage.onFrame((dt) => {
  if (speaking) {
    avatar.setMouth(analyser ? analyser.sample() : boundary.sample(performance.now()));
  } else {
    avatar.setSilent();
  }
  avatar.update(dt);
});

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

shotSel.addEventListener('change', () => stage.frame(avatar.headCenter, shotSel.value as Shot));
rateEl.addEventListener('input', () => boundary.setRate(Number(rateEl.value)));

glbInput.addEventListener('change', async () => {
  const file = glbInput.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  log(`loading ${file.name}…`);
  try {
    const ok = await avatar.loadGltf(url);
    if (ok) {
      stage.frame(avatar.headCenter, shotSel.value as Shot);
      statusEl.textContent = avatar.description;
      log(`loaded ${file.name}: ${avatar.description}`);
    } else {
      log(`${file.name} has no mouth blendshapes — keeping procedural head.`);
    }
  } catch (err) {
    log(`failed to load ${file.name}: ${String(err)}`);
  } finally {
    URL.revokeObjectURL(url);
  }
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
