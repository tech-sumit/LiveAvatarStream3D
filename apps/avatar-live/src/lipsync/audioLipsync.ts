import type { MouthCue } from '../avatar/avatarController.js';

// Amplitude + spectral lipsync from any routable audio (a cloned-voice stream
// from the server, or an uploaded file). Loudness drives jaw; the spectral
// centroid biases between wide (front vowels / sibilants) and round (back vowels).
// This is the accurate path — use it whenever we actually have the audio samples.
export class AudioAnalyserLipsync {
  private analyser: AnalyserNode;
  private time: Uint8Array<ArrayBuffer>;
  private freq: Uint8Array<ArrayBuffer>;
  private jaw = 0;

  constructor(ctx: AudioContext, source: AudioNode) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    source.connect(this.analyser);
    this.time = new Uint8Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
  }

  sample(): MouthCue {
    this.analyser.getByteTimeDomainData(this.time);
    this.analyser.getByteFrequencyData(this.freq);

    // RMS loudness → jaw (with a noise gate and perceptual curve).
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.time.length);
    const gated = rms < 0.02 ? 0 : Math.min(1, (rms - 0.02) * 4.5);
    const target = Math.pow(gated, 0.7);
    // Light smoothing so the jaw doesn't buzz.
    this.jaw += (target - this.jaw) * 0.5;

    // Spectral centroid → vowel color.
    let num = 0;
    let den = 0;
    for (let i = 0; i < this.freq.length; i++) {
      num += i * this.freq[i];
      den += this.freq[i];
    }
    const centroid = den > 0 ? num / den / this.freq.length : 0; // 0..1
    const wide = clamp01((centroid - 0.35) * 2.2) * this.jaw;
    const round = clamp01((0.35 - centroid) * 2.2) * this.jaw;
    const close = this.jaw < 0.08 ? 0.3 : 0;

    return { jawOpen: this.jaw, mouthWide: wide, mouthRound: round, mouthClose: close };
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
