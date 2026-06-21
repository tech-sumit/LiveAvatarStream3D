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
