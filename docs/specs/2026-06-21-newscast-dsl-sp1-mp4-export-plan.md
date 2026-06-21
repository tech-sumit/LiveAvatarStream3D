# SP-1 — MP4/4K Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `apps/avatar-live`'s webm `MediaRecorder` deliverable with a frame-exact **offline** MP4 exporter (WebCodecs `VideoEncoder` + Mediabunny muxer) that renders the Three.js avatar one frame at a time (`t = i/fps`), muxes the cloned-voice narration as a deterministic audio track, and writes a playable `.mp4` at any of the 6 capture resolutions in H.264 (default) or H.265 (when supported).

**Architecture:** A small set of single-purpose modules under `apps/avatar-live/src/capture/` — `mp4Encoder.ts` (Mediabunny/WebCodecs wrapper + codec detection), `offlineLipsync.ts` (precompute a per-frame mouth track from the narration `AudioBuffer`), `offlineAudio.ts` (`OfflineAudioContext` mixdown), and `offlineExporter.ts` (the deterministic frame loop). The exporter drives the avatar through a new shared `Performer.driveAvatarFrame()` (extracted from the realtime `tick()` so preview and export render identically), renders via a new `Stage.renderOutputFrame()`, and is triggered by a new **Export MP4** button. The existing `MediaRecorder` path is kept, relabeled as a throwaway **Quick preview (webm)**. The whole export runs **offline on the main thread** (not wall-clock): the live render loop is suspended during export via a `performing`-style `exporting` flag, so there are zero dropped frames and exact A/V sync. Worker/OffscreenCanvas offload and timeline music-bed muxing are documented follow-ups (Appendix A/B), not built here.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Three.js 0.152.2, Vite, [`mediabunny`](https://mediabunny.dev) v1.49+, WebCodecs `VideoEncoder`, Web Audio `OfflineAudioContext`. No DSL/protocol changes. This is SP-1 of the Newscast DSL build order ([design spec](./2026-06-21-newscast-dsl-design.md) §8.1, §9.5).

**Verification model:** This repo has **no avatar-live test suite** (see project `CLAUDE.md`: "No CI… validate with typecheck/build"). Every task therefore verifies with `npm run typecheck` + `npm run build --workspace @las/avatar-live`, plus, where a behavior is observable, a concrete **browser console smoke** snippet or a **manual studio smoke**. There is no `vitest` for this workspace — do **not** invent one. Per project `CLAUDE.md`, **do not add retries** to the export/record path; failures must surface loudly via `app.log`.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `apps/avatar-live/package.json` | Modify | Add the `mediabunny` dependency. |
| `apps/avatar-live/src/capture/mp4Encoder.ts` | **Create** | Mediabunny + WebCodecs wrapper: mux a canvas video track + one `AudioBuffer` → MP4 `Blob`; codec capability detection. |
| `apps/avatar-live/src/capture/offlineLipsync.ts` | **Create** | Precompute a per-frame `MouthCue[]` from the narration `AudioBuffer` (RMS jaw + spectral-centroid vowel color), mirroring the live analyser. Includes a radix-2 FFT. |
| `apps/avatar-live/src/capture/offlineAudio.ts` | **Create** | `OfflineAudioContext` mixdown of narration (+ future cues) → one deterministic stereo `AudioBuffer`. |
| `apps/avatar-live/src/capture/offlineExporter.ts` | **Create** | The deterministic frame loop: precompute → render each frame via a `driveFrame` callback → encode → finalize → `Blob`. |
| `apps/avatar-live/src/scene/stage.ts` | Modify | Add `renderOutputFrame()` — render the output renderer once on demand and return the capture canvas. |
| `apps/avatar-live/index.html` | Modify | Add the **Export MP4** button, a **video codec** `<select>`, and an **export progress** span; relabel the Record button. |
| `apps/avatar-live/src/app/dom.ts` | Modify | Bind the three new elements. |
| `apps/avatar-live/src/app/recording.ts` | Modify | Codec-select population + `currentFormat()`/`currentCodec()`/`setExportUi()`/`setExportProgress()`; relabel quick-preview UI. |
| `apps/avatar-live/src/app/performer.ts` | Modify | Extract `driveAvatarFrame()` from `tick()`; add `exporting` flag + busy/guard; `prepareForExport()` + `exportMp4()`; wire the Export MP4 button. |
| `progress.md`, `apps/avatar-live/README.md` | Modify | Record SP-1 validation + document the new export + its limitations. |

**Constants used across tasks (must match exactly):**
- Export frame rate: **`30`** fps (matches the existing `captureStream(30)` cadence).
- Mediabunny video codec strings: **`'avc'`** (H.264, default) / **`'hevc'`** (H.265). Audio: **`'aac'`**.
- Mixdown sample rate: **`48000`** (AAC-friendly).
- `MouthCue` shape (from `src/avatar/avatarController.ts`): `{ jawOpen: number; mouthWide: number; mouthRound: number; mouthClose: number }`.
- Narration segment shape (from `Performer`): `{ t: number; gesture: string; emotion?: string }` — `t` is the segment **start** time in seconds.

---

## Task 1: Mediabunny dependency + `Mp4Encoder` wrapper + codec detection

**Files:**
- Modify: `apps/avatar-live/package.json` (dependencies)
- Create: `apps/avatar-live/src/capture/mp4Encoder.ts`

- [ ] **Step 1: Add the dependency**

Run (from repo root):

```bash
npm install mediabunny@^1.49.0 --workspace @las/avatar-live
```

Expected: `apps/avatar-live/package.json` gains `"mediabunny": "^1.49.0"` under `dependencies`, and the root lockfile updates. If the registry pins a newer patch, that is fine — any `1.49.x`/`>=1.49 <2` works.

- [ ] **Step 2: Write `mp4Encoder.ts`**

Create `apps/avatar-live/src/capture/mp4Encoder.ts`:

```ts
import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  QUALITY_HIGH,
  getFirstEncodableVideoCodec,
  canEncodeAudio,
} from 'mediabunny';

export type VideoCodecChoice = 'avc' | 'hevc';

export interface Mp4EncoderOpts {
  canvas: HTMLCanvasElement; // the live capture canvas (Stage output canvas)
  fps: number;
  codec: VideoCodecChoice; // already resolved to a supported codec (see pickVideoCodec)
}

/**
 * Wraps Mediabunny + WebCodecs to mux a canvas video track plus one Web Audio
 * AudioBuffer into an in-memory MP4 Blob. Mediabunny owns the VideoEncoder/
 * AudioEncoder lifecycle + backpressure; awaiting add() is the throttle.
 */
export class Mp4Encoder {
  private output: Output;
  private target: BufferTarget; // typed ref — Output.target is the base `Target`, which has no `.buffer`
  private video: CanvasSource;
  private audio: AudioBufferSource | null = null;
  private fps: number;

  constructor(opts: Mp4EncoderOpts) {
    this.fps = opts.fps;
    this.target = new BufferTarget();
    this.output = new Output({ format: new Mp4OutputFormat(), target: this.target });
    this.video = new CanvasSource(opts.canvas, { codec: opts.codec, bitrate: QUALITY_HIGH });
    this.output.addVideoTrack(this.video, { frameRate: opts.fps });
  }

  /** Add an AAC audio track. Must be called before start(). */
  addAudioTrack(): void {
    this.audio = new AudioBufferSource({ codec: 'aac', bitrate: QUALITY_HIGH });
    this.output.addAudioTrack(this.audio);
  }

  async start(): Promise<void> {
    await this.output.start();
  }

  /** Capture the current canvas pixels as frame `index` (timestamp = index/fps). Awaits backpressure. */
  async addFrame(index: number): Promise<void> {
    await this.video.add(index / this.fps, 1 / this.fps);
  }

  async addAudio(buffer: AudioBuffer): Promise<void> {
    if (!this.audio) throw new Error('Mp4Encoder: addAudioTrack() must be called before start()');
    await this.audio.add(buffer);
  }

  /** Finalize and return the MP4 Blob. */
  async finish(): Promise<Blob> {
    await this.output.finalize();
    const buf = this.target.buffer;
    if (!buf) throw new Error('Mp4Encoder: encoder produced no output');
    return new Blob([buf], { type: 'video/mp4' });
  }
}

/**
 * Resolve the best available video codec for a resolution. Prefers H.265 only when
 * asked AND supported, else falls back to H.264. Returns null if neither encodes.
 * (Mediabunny's helper wraps VideoEncoder.isConfigSupported with the exact config it
 * will use, so it is more reliable than calling isConfigSupported directly.)
 */
export async function pickVideoCodec(
  prefer: VideoCodecChoice,
  width: number,
  height: number,
): Promise<VideoCodecChoice | null> {
  const order: VideoCodecChoice[] = prefer === 'hevc' ? ['hevc', 'avc'] : ['avc'];
  const codec = await getFirstEncodableVideoCodec(order, { width, height });
  return (codec as VideoCodecChoice | null) ?? null;
}

/** Whether this browser can export MP4 (WebCodecs present + an H.264 path + AAC) at a size. */
export async function canExportMp4(width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  const v = await getFirstEncodableVideoCodec(['avc'], { width, height });
  const a = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 });
  return !!v && a;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace @las/avatar-live`
Expected: PASS (no errors). If `mediabunny` types are missing, re-run Step 1 — the package ships its own `.d.ts`.

- [ ] **Step 4: Build**

Run: `npm run build --workspace @las/avatar-live`
Expected: PASS — Vite bundles `mediabunny` without "failed to resolve import".

- [ ] **Step 5: Console smoke (real artifact)**

Run `npm run dev:avatar` and open http://localhost:5175. In the browser devtools console, paste:

```js
const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
const x = c.getContext('2d');
const { Mp4Encoder } = await import('/src/capture/mp4Encoder.ts');
const enc = new Mp4Encoder({ canvas: c, fps: 30, codec: 'avc' });
await enc.start();
for (let i = 0; i < 30; i++) { x.fillStyle = `hsl(${i * 12},80%,50%)`; x.fillRect(0, 0, 1280, 720); await enc.addFrame(i); }
const blob = await enc.finish();
console.log('mp4 bytes:', blob.size);
const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'smoke.mp4'; a.click();
```

Expected: logs a non-zero byte count (tens of KB) and downloads `smoke.mp4` — a 1-second color-sweep that **plays in QuickTime/VLC/Chrome**. (This is video-only; audio is exercised in Task 8.)

- [ ] **Step 6: Commit**

```bash
git add apps/avatar-live/package.json apps/avatar-live/src/capture/mp4Encoder.ts package-lock.json
git commit -m "feat(avatar-live): add Mediabunny+WebCodecs Mp4Encoder + codec detection (SP-1)"
```

---

## Task 2: Offline per-frame lip-sync track

**Files:**
- Create: `apps/avatar-live/src/capture/offlineLipsync.ts`

Why: the live lip-sync (`src/lipsync/audioLipsync.ts`) reads a realtime `AnalyserNode`, which cannot be sampled per-frame offline. This reproduces the same math (RMS → jaw with noise gate + gamma + asymmetric smoothing; spectral centroid → wide/round) deterministically from the narration `AudioBuffer`, so the exported MP4 lips match the preview.

- [ ] **Step 1: Write `offlineLipsync.ts`**

Create `apps/avatar-live/src/capture/offlineLipsync.ts`:

```ts
import type { MouthCue } from '../avatar/avatarController.js';

// Mirrors src/lipsync/audioLipsync.ts (AudioAnalyserLipsync) but computes per-frame
// mouth shapes offline from PCM, so the offline export looks like the realtime preview.
const FFT = 1024;

/** One MouthCue per output frame (length = ceil(buffer.duration * fps)). */
export function precomputeMouthTrack(buffer: AudioBuffer, fps: number): MouthCue[] {
  const sr = buffer.sampleRate;
  const pcm = toMono(buffer);
  const frames = Math.max(1, Math.ceil(buffer.duration * fps));
  const re = new Float32Array(FFT);
  const im = new Float32Array(FFT);
  const out: MouthCue[] = [];
  let jaw = 0;
  for (let f = 0; f < frames; f++) {
    const center = Math.round((f / fps) * sr);
    const start = Math.max(0, center - FFT / 2);

    // RMS loudness over the window.
    let sum = 0;
    for (let i = 0; i < FFT; i++) {
      const s = pcm[start + i] ?? 0;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / FFT);

    // Calibrated jaw: noise-gated, gamma>1, asymmetric smoothing — matches audioLipsync.
    const norm = clamp01((rms - 0.045) / 0.175);
    const target = Math.pow(norm, 1.3);
    const k = target > jaw ? 0.6 : 0.5;
    jaw += (target - jaw) * k;
    if (jaw < 0.05) jaw = 0;

    // Spectral centroid (Hann-windowed FFT magnitude) → vowel color, scaled by openness.
    for (let i = 0; i < FFT; i++) {
      const s = pcm[start + i] ?? 0;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1));
      re[i] = s * w;
      im[i] = 0;
    }
    fft(re, im);
    let cnum = 0;
    let cden = 0;
    const half = FFT / 2;
    for (let i = 0; i < half; i++) {
      const mag = Math.hypot(re[i], im[i]);
      cnum += i * mag;
      cden += mag;
    }
    const centroid = cden > 0 ? cnum / cden / half : 0; // 0..1
    const wide = clamp01((centroid - 0.35) * 2.2) * jaw;
    const round = clamp01((0.35 - centroid) * 2.2) * jaw;

    out.push({ jawOpen: jaw, mouthWide: wide, mouthRound: round, mouthClose: 0 });
  }
  return out;
}

function toMono(buffer: AudioBuffer): Float32Array {
  const ch0 = buffer.getChannelData(0);
  if (buffer.numberOfChannels === 1) return ch0;
  const ch1 = buffer.getChannelData(1);
  const out = new Float32Array(ch0.length);
  for (let i = 0; i < ch0.length; i++) out[i] = (ch0[i] + ch1[i]) * 0.5;
  return out;
}

// In-place iterative radix-2 Cooley–Tukey FFT (length must be a power of two).
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wre = Math.cos(ang);
    const wim = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cre = 1;
      let cim = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tre = re[b] * cre - im[b] * cim;
        const tim = re[b] * cim + im[b] * cre;
        re[b] = re[a] - tre;
        im[b] = im[a] - tim;
        re[a] += tre;
        im[a] += tim;
        const ncre = cre * wre - cim * wim;
        cim = cre * wim + cim * wre;
        cre = ncre;
      }
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace @las/avatar-live`
Expected: PASS.

- [ ] **Step 3: Console smoke**

With `npm run dev:avatar` running, in the console:

```js
const { precomputeMouthTrack } = await import('/src/capture/offlineLipsync.ts');
const ac = new AudioContext();
const sr = ac.sampleRate, dur = 1.0;
const buf = ac.createBuffer(1, sr * dur, sr);
const d = buf.getChannelData(0);
for (let i = 0; i < d.length; i++) d[i] = (i < d.length / 2) ? 0.4 * Math.sin(2 * Math.PI * 200 * i / sr) : 0; // tone then silence
const track = precomputeMouthTrack(buf, 30);
console.log('frames:', track.length, 'open@start:', track[3].jawOpen.toFixed(2), 'closed@end:', track[track.length - 1].jawOpen.toFixed(2));
```

Expected: `frames: 30`, `open@start` > 0.3, `closed@end` = 0.00 (mouth closes in the silent half). PASS = jaw tracks loudness.

- [ ] **Step 4: Commit**

```bash
git add apps/avatar-live/src/capture/offlineLipsync.ts
git commit -m "feat(avatar-live): offline per-frame lip-sync precompute from AudioBuffer (SP-1)"
```

---

## Task 3: Offline audio mixdown

**Files:**
- Create: `apps/avatar-live/src/capture/offlineAudio.ts`

- [ ] **Step 1: Write `offlineAudio.ts`**

Create `apps/avatar-live/src/capture/offlineAudio.ts`:

```ts
/** A scheduled non-narration clip (music bed / sfx) for the mixdown. (Wired to the timeline in a follow-up; narration alone is the SP-1 MVP.) */
export interface AudioClip {
  buffer: AudioBuffer;
  start: number; // seconds on the timeline
  volume: number; // 0..1
  fadeIn: number; // seconds
  fadeOut: number; // seconds
}

export interface MixdownOpts {
  narration: AudioBuffer; // the spoken track; starts at t=0
  cues: AudioClip[]; // additional clips (may be empty for MVP)
  durationSec: number; // total render length
  sampleRate?: number; // default 48000 (AAC-friendly)
}

/** Offline-render the narration + scheduled cues into one deterministic stereo AudioBuffer. */
export async function renderMixdown(opts: MixdownOpts): Promise<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? 48000;
  const length = Math.max(1, Math.ceil(opts.durationSec * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });

  schedule(ctx, opts.narration, 0, 1, 0, 0);
  for (const c of opts.cues) schedule(ctx, c.buffer, c.start, c.volume, c.fadeIn, c.fadeOut);

  return ctx.startRendering();
}

function schedule(
  ctx: OfflineAudioContext,
  buffer: AudioBuffer,
  startSec: number,
  volume: number,
  fadeIn: number,
  fadeOut: number,
): void {
  const src = ctx.createBufferSource();
  src.buffer = buffer; // resampled to ctx.sampleRate automatically if rates differ
  const g = ctx.createGain();
  const end = startSec + buffer.duration;
  if (fadeIn > 0) {
    g.gain.setValueAtTime(0, startSec);
    g.gain.linearRampToValueAtTime(volume, startSec + fadeIn);
  } else {
    g.gain.setValueAtTime(volume, startSec);
  }
  if (fadeOut > 0) {
    g.gain.setValueAtTime(volume, Math.max(startSec + fadeIn, end - fadeOut));
    g.gain.linearRampToValueAtTime(0, end);
  }
  src.connect(g).connect(ctx.destination);
  src.start(startSec);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace @las/avatar-live`
Expected: PASS.

- [ ] **Step 3: Console smoke**

```js
const { renderMixdown } = await import('/src/capture/offlineAudio.ts');
const ac = new AudioContext();
const sr = ac.sampleRate;
const nar = ac.createBuffer(1, sr * 2, sr); // 2s of (silent) narration
const mix = await renderMixdown({ narration: nar, cues: [], durationSec: 2 });
console.log('mixdown channels/dur:', mix.numberOfChannels, mix.duration.toFixed(2));
```

Expected: `mixdown channels/dur: 2 2.00`. PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/avatar-live/src/capture/offlineAudio.ts
git commit -m "feat(avatar-live): OfflineAudioContext mixdown for export (SP-1)"
```

---

## Task 4: `Stage.renderOutputFrame()`

**Files:**
- Modify: `apps/avatar-live/src/scene/stage.ts`

Why: the export must render the **output** renderer once, synchronously, per frame (the existing per-frame render is private to the internal RAF tick). This adds an on-demand single-frame render that returns the capture canvas. It mirrors the existing output-render branch (`stage.ts` ~lines 260–272) which renders `screenScene/screenCam` when the output source is the screen, else `scene/camera`.

- [ ] **Step 1: Read the existing render + fields**

Run: `grep -nE 'private outputCanvas|outputRenderer.render|screenScene|screenCam|get outputIsScreen' apps/avatar-live/src/scene/stage.ts`
Expected: confirms `outputCanvas`, `outputRenderer`, `screenScene`, `screenCam` fields and the `outputIsScreen` getter exist. (Used by the method below.)

- [ ] **Step 2: Add the method**

In `apps/avatar-live/src/scene/stage.ts`, add this method to the `Stage` class (place it directly after the existing `captureStream(...)` method so capture-related members stay together):

```ts
  /**
   * Render one output frame on demand (offline export) and return the capture
   * canvas. Mirrors the per-frame output render in the internal loop, but is
   * called synchronously by the exporter rather than by requestAnimationFrame.
   */
  renderOutputFrame(): HTMLCanvasElement {
    if (this.outputIsScreen) {
      this.outputRenderer.render(this.screenScene, this.screenCam);
    } else {
      this.outputRenderer.render(this.scene, this.camera);
    }
    return this.outputCanvas;
  }
```

> If `outputCanvas` is declared `private`, that is fine — this method is inside the `Stage` class. If the grep in Step 1 shows the screen scene/camera use different field names (e.g. `screenScene` is named `screen`), substitute the exact names from the existing output-render branch.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS.

- [ ] **Step 4: Console smoke**

```js
const cv = window.__las.stage.renderOutputFrame();
console.log('canvas:', cv.width + 'x' + cv.height);
// non-blank check: draw it into a 2d canvas and read a center pixel
const t = document.createElement('canvas'); t.width = cv.width; t.height = cv.height;
t.getContext('2d').drawImage(cv, 0, 0);
console.log('center pixel:', t.getContext('2d').getImageData(cv.width / 2, cv.height / 2, 1, 1).data.join(','));
```

Expected: prints the capture size and a non-`0,0,0,0` center pixel (the studio/avatar is visible). PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/avatar-live/src/scene/stage.ts
git commit -m "feat(avatar-live): Stage.renderOutputFrame() for on-demand offline render (SP-1)"
```

---

## Task 5: The offline exporter (frame loop)

**Files:**
- Create: `apps/avatar-live/src/capture/offlineExporter.ts`

This ties the pieces together. It owns the deterministic loop but **not** the avatar logic: the caller passes a `driveFrame(t, dt, mouth)` callback (Task 8 wires this to `Performer.driveAvatarFrame`, which is the same code the realtime preview uses).

- [ ] **Step 1: Write `offlineExporter.ts`**

Create `apps/avatar-live/src/capture/offlineExporter.ts`:

```ts
import type { Stage } from '../scene/stage.js';
import type { MouthCue } from '../avatar/avatarController.js';
import { Mp4Encoder, pickVideoCodec, type VideoCodecChoice } from './mp4Encoder.js';
import { precomputeMouthTrack } from './offlineLipsync.js';
import { renderMixdown, type AudioClip } from './offlineAudio.js';

export interface OfflineExportOpts {
  stage: Stage;
  narration: AudioBuffer;
  audioCues: AudioClip[]; // [] for SP-1 MVP (music beds are a follow-up)
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  codec: VideoCodecChoice;
  /** Per-frame avatar drive (camera/emotion/clip/mouth/step). Caller supplies it. */
  driveFrame: (t: number, dt: number, mouth: MouthCue) => void;
  onProgress?: (done: number, total: number) => void;
}

const SILENT: MouthCue = { jawOpen: 0, mouthWide: 0, mouthRound: 0, mouthClose: 0 };

/**
 * Frame-exact offline MP4 export. Drives the clock by frame index (t = i/fps), so
 * there are zero dropped frames and the muxed audio stays in exact sync. Runs on the
 * main thread; yields every 30 frames so the progress UI can paint. The caller MUST
 * have suspended the realtime render loop (see Performer.exporting) before calling.
 */
export async function exportMp4Offline(opts: OfflineExportOpts): Promise<Blob> {
  const codec = await pickVideoCodec(opts.codec, opts.width, opts.height);
  if (!codec) throw new Error('No MP4 video codec available in this browser');

  const total = Math.max(1, Math.ceil(opts.durationSec * opts.fps));
  const mouth = precomputeMouthTrack(opts.narration, opts.fps);
  const audio = await renderMixdown({
    narration: opts.narration,
    cues: opts.audioCues,
    durationSec: opts.durationSec,
  });

  const canvas = opts.stage.renderOutputFrame(); // stable canvas ref for the encoder
  const enc = new Mp4Encoder({ canvas, fps: opts.fps, codec });
  enc.addAudioTrack();
  await enc.start();

  const dt = 1 / opts.fps;
  for (let i = 0; i < total; i++) {
    const t = i / opts.fps;
    opts.driveFrame(t, dt, mouth[i] ?? SILENT);
    opts.stage.renderOutputFrame();
    await enc.addFrame(i);
    if (opts.onProgress && (i % 5 === 0 || i === total - 1)) opts.onProgress(i + 1, total);
    if (i % 30 === 0) await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
  }

  await enc.addAudio(audio);
  return enc.finish();
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS. (Behavioral verification happens in Task 8, once a caller wires `driveFrame`.)

- [ ] **Step 3: Commit**

```bash
git add apps/avatar-live/src/capture/offlineExporter.ts
git commit -m "feat(avatar-live): frame-exact offline MP4 exporter loop (SP-1)"
```

---

## Task 6: UI — Export MP4 button, codec select, progress; relabel Record

**Files:**
- Modify: `apps/avatar-live/index.html`
- Modify: `apps/avatar-live/src/app/dom.ts`

- [ ] **Step 1: Locate the capture controls in `index.html`**

Run: `grep -nE 'id="record"|id="captureFormat"|id="download"|id="gateLabel"' apps/avatar-live/index.html`
Expected: shows the record button, the capture-format `<select>`, the download anchor, and the gate label — the controls block to extend.

- [ ] **Step 2: Add the new controls + relabel Record**

In `apps/avatar-live/index.html`, immediately after the `id="captureFormat"` `<select>` element, add:

```html
        <select id="videoCodec" title="Export codec">
          <option value="avc">H.264 (MP4)</option>
          <option value="hevc">H.265 / HEVC (MP4, if supported)</option>
        </select>
        <button id="exportMp4">⬇ Export MP4</button>
        <span id="exportProgress" class="muted"></span>
```

Then change the existing Record button's label so it reads as the throwaway preview. Find the button with `id="record"` and set its text to:

```html
        <button id="record">● Quick preview (webm)</button>
```

> Keep the element ids exactly (`videoCodec`, `exportMp4`, `exportProgress`, `record`). If `index.html` has no `class="muted"`, drop the `class` attribute — it is cosmetic.

- [ ] **Step 3: Bind the elements in `dom.ts`**

In `apps/avatar-live/src/app/dom.ts`, in the object returned by `bindDom()`, add these three entries next to the existing `captureFormatSel` binding:

```ts
    exportMp4Btn: $<HTMLButtonElement>('exportMp4'),
    videoCodecSel: $<HTMLSelectElement>('videoCodec'),
    exportProgressEl: $<HTMLSpanElement>('exportProgress'),
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS. (`Dom` type now includes the three new members.)

- [ ] **Step 5: Visual check**

With `npm run dev:avatar` running, confirm the **⬇ Export MP4** button, the **H.264/H.265** dropdown, and an (empty) progress span appear, and the old Record button now reads **● Quick preview (webm)**.

- [ ] **Step 6: Commit**

```bash
git add apps/avatar-live/index.html apps/avatar-live/src/app/dom.ts
git commit -m "feat(avatar-live): export-MP4 button, codec select, progress; relabel record→preview (SP-1)"
```

---

## Task 7: Recording controller — codec/format accessors + export UI

**Files:**
- Modify: `apps/avatar-live/src/app/recording.ts`

Why: `Recording` already owns the 6 capture formats and the format `<select>`. Add read accessors the exporter needs, an export-progress/UI helper, and an optional probe that annotates the H.265 option when unsupported. Keep `Recording` free of the export orchestration (that lives in `Performer`, Task 8) — it just exposes state + UI.

- [ ] **Step 1: Add accessors + export UI to `recording.ts`**

In `apps/avatar-live/src/app/recording.ts`, import the codec helpers at the top:

```ts
import { canExportMp4, type VideoCodecChoice } from '../capture/mp4Encoder.js';
```

Then add these methods to the `Recording` class (after the existing `applyFormat` method):

```ts
  /** The currently selected capture resolution. */
  currentFormat(): { w: number; h: number } {
    const f = CAPTURE_FORMATS[Number(this.app.dom.captureFormatSel.value)] ?? CAPTURE_FORMATS[0];
    return { w: f.w, h: f.h };
  }

  /** The currently selected export codec ('avc' default, 'hevc' if the user picked it). */
  currentCodec(): VideoCodecChoice {
    return (this.app.dom.videoCodecSel.value as VideoCodecChoice) ?? 'avc';
  }

  /** Disable export/preview controls while an export is running. */
  setExportUi(on: boolean): void {
    const d = this.app.dom;
    d.exportMp4Btn.disabled = on;
    d.recordBtn.disabled = on;
    d.exportMp4Btn.textContent = on ? '… exporting' : '⬇ Export MP4';
  }

  /** Show export progress; (0,0) clears it. */
  setExportProgress(done: number, total: number): void {
    this.app.dom.exportProgressEl.textContent = total > 0 ? `${Math.round((done / total) * 100)}%` : '';
  }

  /** Probe MP4 capability; annotate or disable the H.265 option when unavailable. */
  private async probeCodecs(): Promise<void> {
    const d = this.app.dom;
    const okMp4 = await canExportMp4(1920, 1080);
    if (!okMp4) {
      this.app.log('note: this browser lacks WebCodecs MP4 — Export MP4 will fall back to webm.');
    }
    const { pickVideoCodec } = await import('../capture/mp4Encoder.js');
    const hevc = await pickVideoCodec('hevc', 1920, 1080);
    if (hevc !== 'hevc') {
      const opt = Array.from(d.videoCodecSel.options).find((o) => o.value === 'hevc');
      if (opt) {
        opt.textContent = 'H.265 / HEVC (unsupported here)';
        opt.disabled = true;
      }
    }
  }
```

- [ ] **Step 2: Kick off the probe in `init()`**

In `recording.ts`, at the end of the existing `init()` method (after `this.applyFormat();`), add:

```ts
    void this.probeCodecs();
```

- [ ] **Step 3: Relabel the quick-preview UI strings**

In `recording.ts`, update `setRecUi()` so the webm path reads as a preview. Replace its body's button text line:

```ts
    d.recordBtn.textContent = on ? '■ Stop preview' : '● Quick preview (webm)';
```

(Leave the `rec` class toggles unchanged.)

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/avatar-live/src/app/recording.ts
git commit -m "feat(avatar-live): Recording codec/format accessors + export UI + HEVC probe (SP-1)"
```

---

## Task 8: Performer — shared frame drive + `exportMp4()` + button wiring

**Files:**
- Modify: `apps/avatar-live/src/app/performer.ts`

This is the integration task. It (a) extracts the per-frame avatar drive from `tick()` into `driveAvatarFrame()` so preview and export render identically (DRY), (b) adds an `exporting` flag that suspends the live loop and feeds the busy guard, (c) adds `prepareForExport()` + `exportMp4()`, and (d) wires the Export MP4 button.

- [ ] **Step 1: Add the `exporting` field + busy guard**

In `apps/avatar-live/src/app/performer.ts`, add the field next to the other private state (near `private narrationAudio`):

```ts
  private exporting = false;
```

Update the `busy` getter (currently `return this.performing || this.render != null;`) to:

```ts
  get busy(): boolean {
    return this.performing || this.render != null || this.exporting;
  }
```

- [ ] **Step 2: Guard the realtime loop during export**

In `performer.ts`, add a guard as the **first line** of the `tick` arrow (`private tick = (dt: number): void => {`):

```ts
    if (this.exporting) return; // offline export drives the avatar; don't double-step
```

- [ ] **Step 3: Extract `driveAvatarFrame()` and call it from `tick()`**

In `performer.ts`, add this private method (place it directly above `tick`):

```ts
  /**
   * Per-frame avatar drive shared by the realtime tick and the offline exporter:
   * sets mouth + gaze, advances the narration-segment cursor (emotion + talk clip),
   * and steps the avatar. `cursor.idx` is the last-applied segment index.
   */
  private driveAvatarFrame(
    t: number,
    dt: number,
    mouth: MouthCue,
    segs: { t: number; gesture: string; emotion?: string }[],
    cursor: { idx: number },
  ): void {
    const { app } = this;
    const { avatar, stage } = app;
    avatar.setMouth(mouth);
    avatar.setGazeTarget(stage.cameraWorldPosition());
    while (cursor.idx + 1 < segs.length && segs[cursor.idx + 1].t <= t) {
      cursor.idx++;
      const seg = segs[cursor.idx];
      const emo = (seg.emotion as EmotionName) ?? (app.dom.emotionSel.value as EmotionName);
      avatar.setEmotion(emo);
      if (avatar.animationClips.length) {
        this.lastTalkClip = selectTalkClip(seg.gesture as Gesture, emo, this.lastTalkClip);
        avatar.playClip(this.lastTalkClip);
      }
    }
    avatar.update(dt);
  }
```

Then replace the realtime render branch in `tick` — the block that currently reads:

```ts
    if (this.render) {
      const t = this.render.ctx.currentTime - this.render.start;
      if (t >= 0) {
        deps.timeline.setUiPlayhead(t);
        deps.timeline.playerUpdate(t);
        avatar.setMouth(this.render.analyser.sample());
        avatar.setGazeTarget(stage.cameraWorldPosition());
        while (this.render.idx + 1 < this.render.timeline.length && this.render.timeline[this.render.idx + 1].t <= t) {
          this.render.idx++;
          const seg = this.render.timeline[this.render.idx];
          const emo = (seg.emotion as EmotionName) ?? (app.dom.emotionSel.value as EmotionName);
          avatar.setEmotion(emo);
          if (avatar.animationClips.length) {
            this.lastTalkClip = selectTalkClip(seg.gesture as Gesture, emo, this.lastTalkClip);
            avatar.playClip(this.lastTalkClip);
          }
        }
      }
      avatar.update(dt);
      return;
    }
```

with the DRY version (identical behavior — `driveAvatarFrame` does mouth+gaze+segs+update; the `t < 0` pre-roll just steps the avatar):

```ts
    if (this.render) {
      const t = this.render.ctx.currentTime - this.render.start;
      if (t >= 0) {
        deps.timeline.setUiPlayhead(t);
        deps.timeline.playerUpdate(t);
        this.driveAvatarFrame(t, dt, this.render.analyser.sample(), this.render.timeline, this.render);
      } else {
        avatar.update(dt);
      }
      return;
    }
```

> `this.render` is `{ ctx, start, analyser, timeline, idx }`, so passing it as the `cursor` ({ idx }) preserves the existing `this.render.idx` advance. `EmotionName`, `Gesture`, and `selectTalkClip` are already imported in this file; `MouthCue` is **not** — add it via the Step-4 import.

- [ ] **Step 4: Add `prepareForExport()` + `exportMp4()`**

In `performer.ts`, add the imports at the top (next to the other `../capture`/lipsync imports):

```ts
import { exportMp4Offline } from '../capture/offlineExporter.js';
import type { MouthCue } from '../avatar/avatarController.js'; // used by driveAvatarFrame; NOT already imported in performer.ts
```

Add these methods to the `Performer` class (place them after `buildNarration`):

```ts
  /** Build (or reuse) narration and return the pieces the offline exporter needs. */
  private async prepareForExport(): Promise<
    { buffer: AudioBuffer; segs: { t: number; gesture: string; emotion?: string }[]; durationSec: number } | null
  > {
    if (!this.narrationAudio) {
      if (!(await this.buildNarration())) return null;
    }
    const buffer = this.narrationAudio!;
    return { buffer, segs: this.narrationSegs, durationSec: buffer.length / buffer.sampleRate };
  }

  /** Frame-exact offline MP4 export of the current script at the selected resolution + codec. */
  exportMp4 = async (): Promise<void> => {
    const { app, deps } = this;
    if (this.exporting || app.isBusy()) {
      app.log('finish the current take before exporting.');
      return;
    }
    const prep = await this.prepareForExport();
    if (!prep) return; // buildNarration already logged why
    const fmt = deps.recording.currentFormat();
    const codec = deps.recording.currentCodec();
    this.exporting = true;
    deps.recording.setExportUi(true);
    app.log(`export: rendering ${prep.durationSec.toFixed(1)}s @ ${fmt.w}×${fmt.h} ${codec.toUpperCase()} …`);
    try {
      const cursor = { idx: -1 };
      const blob = await exportMp4Offline({
        stage: app.stage,
        narration: prep.buffer,
        audioCues: [],
        durationSec: prep.durationSec,
        fps: 30,
        width: fmt.w,
        height: fmt.h,
        codec,
        driveFrame: (t, dt, mouth) => {
          deps.timeline.playerUpdate(t); // camera / motion / screen cuts
          this.driveAvatarFrame(t, dt, mouth, prep.segs, cursor);
        },
        onProgress: (d, n) => deps.recording.setExportProgress(d, n),
      });
      deps.recording.downloadClip(URL.createObjectURL(blob), 'avatar-take.mp4');
      app.log(`export ready · ${prep.durationSec.toFixed(1)}s ${fmt.w}×${fmt.h} mp4`);
    } catch (err) {
      app.log(`export failed: ${String(err)}`);
    } finally {
      this.exporting = false;
      deps.recording.setExportUi(false);
      deps.recording.setExportProgress(0, 0);
    }
  };
```

- [ ] **Step 5: Wire the Export MP4 button**

In `performer.ts` `init()`, alongside the other button listeners (e.g. after the `d.recordBtn` listener), add:

```ts
    d.exportMp4Btn.addEventListener('click', () => void this.exportMp4());
```

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS.

- [ ] **Step 7: Manual studio smoke (the key acceptance test)**

1. `npm run dev:avatar` → http://localhost:5175. Confirm `apps/avatar-live/.env` has `ELEVENLABS_API_KEY` (cloned-voice TTS is required for narration audio; Web Speech produces no capturable buffer — see Appendix B).
2. Pick a **cloned/ElevenLabs voice** in the voice dropdown.
3. Type 2–3 sentences in the script box.
4. Choose **1080p** in the capture-format select and **H.264** in the codec select.
5. Click **⬇ Export MP4**. Watch the log ("rendering …") and the progress span climb 0→100%; the avatar/preview may freeze during export (expected — main-thread offline render).
6. `avatar-take.mp4` downloads. Open it in QuickTime/VLC/Chrome.

Expected: a 1080p MP4 that **plays with the avatar speaking, lips synced to the audio, audio present and in sync**, no dropped/janky frames. Re-run at **4K UHD** and (if the H.265 option is enabled) **H.265** — both produce playable files. PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/avatar-live/src/app/performer.ts
git commit -m "feat(avatar-live): frame-exact Export MP4 (offline render + synced audio), shared frame drive (SP-1)"
```

---

## Task 9: WebM fallback + final smoke matrix + docs

**Files:**
- Modify: `apps/avatar-live/src/app/performer.ts` (fallback branch)
- Modify: `progress.md`, `apps/avatar-live/README.md`

- [ ] **Step 1: Add a WebM fallback when MP4 is unavailable**

In `performer.ts`, import the capability check at the top:

```ts
import { canExportMp4 } from '../capture/mp4Encoder.js';
```

In `exportMp4`, immediately after computing `fmt` and `codec` (before setting `this.exporting = true`), add:

```ts
    if (!(await canExportMp4(fmt.w, fmt.h))) {
      app.log('MP4/WebCodecs unavailable here — falling back to the webm quick preview.');
      void this.perform(true); // realtime MediaRecorder path (webm)
      return;
    }
```

> `this.perform(true)` is the existing realtime record path (the "quick preview"); reusing it as the fallback keeps a single webm code path. No retries are added (per `CLAUDE.md`).

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS.

- [ ] **Step 3: Smoke matrix (manual)**

With `npm run dev:avatar`, verify each row produces a playable file with synced audio:

| Resolution | Codec | Expected |
|---|---|---|
| 720p | H.264 | playable mp4, fast |
| 1080p | H.264 | playable mp4 |
| 4K UHD | H.264 | playable mp4 (slower; may take longer per frame) |
| 1080p | H.265 | playable mp4 if option enabled; else option is disabled |
| vertical 1080×1920 | H.264 | playable portrait mp4 |

Also confirm: clicking **Export MP4** while a Speak/preview/record is active logs "finish the current take…" and does nothing (busy guard).

- [ ] **Step 4: Update docs**

In `apps/avatar-live/README.md`, under the recording/export section, add a short note:

```markdown
### Export

- **⬇ Export MP4** renders the script frame-exactly **offline** (WebCodecs + Mediabunny)
  to a `.mp4` at the selected resolution (720p–4K, vertical, square) in H.264 (default)
  or H.265 (when the browser supports it). Audio (cloned-voice narration) is muxed in
  sync. The preview may freeze during export — it renders on the main thread.
- **● Quick preview (webm)** is the old realtime `MediaRecorder` capture, kept for a
  fast throwaway preview. Web Speech audio is not capturable; use a cloned voice for
  audio in the exported MP4.
```

In `progress.md`, add a dated SP-1 validation line:

```markdown
- 2026-06-21 — SP-1 (Newscast DSL): frame-exact offline MP4/4K export (WebCodecs + Mediabunny)
  replaces the webm MediaRecorder deliverable in apps/avatar-live; H.264 default, H.265 gated,
  cloned-voice audio muxed in sync. MediaRecorder kept as "quick preview (webm)". Validated via
  typecheck + build + manual studio smoke across 720p/1080p/4K/vertical.
```

- [ ] **Step 5: Commit**

```bash
git add apps/avatar-live/src/app/performer.ts apps/avatar-live/README.md progress.md
git commit -m "feat(avatar-live): webm fallback for MP4 export + SP-1 docs/validation (SP-1)"
```

---

## Appendix A — Tier-2 premium master (NOT built in SP-1)

The design (§8.1) calls for an optional higher-quality master via the existing GPU finishing chain (`services/gpu/finishing/pipeline.py`: GFPGAN restore → Real-ESRGAN ×4 → RIFE → libx264 CRF-16 + AAC). This is a **separate later task**, intentionally out of SP-1 scope. Approach when picked up:

1. Add an "HQ master (server)" checkbox; when set, after the client export, POST the frames (or the client MP4) + the mixdown audio to a finishing endpoint.
2. Parameterize the pipeline's hardcoded `TARGET_H/W = 1080/1920` to honor 1440p/4K (note: the H100 has no NVENC, so the server's value is the AI restore/SR/interpolation, not encode speed).
3. Surface job status via the existing control-api job polling.

Do not implement this now — SP-1 ships the client-side deliverable only.

## Appendix B — Known limitations (state honestly; do not silently cap)

- **Web Speech narration has no audio.** Browser Web Speech TTS synthesizes to the speakers, not to an `AudioBuffer`, so it cannot be muxed. `prepareForExport()` only has audio when narration came from the cloned-voice/ElevenLabs path (`narrationAudio` is set by `buildNarration`). With Web Speech, `buildNarration` logs that it needs ElevenLabs and export aborts. **Document: use a cloned voice for exported audio.**
- **Main-thread render freezes the UI** during export (the loop yields every 30 frames for progress, but the page is busy). Worker + `OffscreenCanvas` offload (per §8.1) is a follow-up; it requires moving the output `WebGLRenderer` to an `OffscreenCanvas`, a larger change deferred from SP-1.
- **Music beds / SFX not yet muxed.** `offlineAudio.renderMixdown` and `OfflineExportOpts.audioCues` already support clips; SP-1 passes `[]`. Wiring the timeline's audio cues (decode their sources to `AudioBuffer` via `app.audio().decodeAudioData`) into `audioCues` is a small follow-up.
- **Blink/idle determinism.** The export steps `avatar.update(1/fps)` per frame; if `avatarController.update` reads wall-clock anywhere (rather than accumulating `dt`), blink timing may differ slightly run-to-run. Lip-sync, emotion, and camera are fully frame-exact. Confirm with `grep -n 'performance.now\|Date.now' apps/avatar-live/src/avatar/avatarController.ts`; if found in `update`, thread a frame clock in a follow-up.

---

## Self-Review

**1. Spec coverage (§8.1 / §9.5 SP-1):**
- Replace webm MediaRecorder deliverable → Tasks 1,5,8 (Export MP4 is the deliverable; webm demoted to preview). ✓
- Frame-exact offline render, `t=i/fps`, zero dropped frames → Task 5 (frame-index loop), Task 8 (`exporting` suspends the realtime loop). ✓
- WebCodecs + Mediabunny muxer → Task 1. ✓
- Web-Audio mix → AudioBuffer track (fixes "no audio" for the cloned-voice path) → Task 3 + Task 8; Web Speech limitation stated in Appendix B. ✓
- 6 capture resolutions reused → Task 7 (`currentFormat` reads the existing `CAPTURE_FORMATS`). ✓
- H.264 default, H.265 gated → Tasks 1 (`pickVideoCodec`), 6 (select), 7 (probe). ✓
- Feature-detect + WebM fallback → Task 1 (`canExportMp4`), Task 9 (fallback to `perform(true)`). ✓
- Keep MediaRecorder as quick preview → Tasks 6,7 (relabel), Task 9 (reused as fallback). ✓
- Integrate with Recording + Performer perform/record flow → Tasks 7,8. ✓
- Tier-2 server master noted, not built → Appendix A. ✓
- No DSL/protocol work → confirmed (no `packages/protocol` changes). ✓

**2. Placeholder scan:** No "TBD/TODO/handle errors"; every code step is complete code; verification uses real commands + concrete console/manual smokes (no fictitious `vitest`). ✓

**3. Type consistency:** `VideoCodecChoice` ('avc'|'hevc') defined in Task 1, used in 5,7,8. `MouthCue` shape consistent (Tasks 2,5,8). Narration seg shape `{ t; gesture; emotion? }` consistent (Tasks 5,8 + matches `Performer.narrationSegs`). `Mp4Encoder` ctor (`{canvas, fps, codec}`) matches its call in Task 5. `renderMixdown`/`AudioClip` (Task 3) match the import in Task 5. `exportMp4Offline` opts (Task 5) match the call in Task 8. New dom ids (`exportMp4Btn`, `videoCodecSel`, `exportProgressEl`) defined in Task 6, used in 7,8. `Recording` methods (`currentFormat`, `currentCodec`, `setExportUi`, `setExportProgress`) defined in Task 7, called in Task 8. `Stage.renderOutputFrame()` defined in Task 4, used in 5. ✓
