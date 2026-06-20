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

  constructor(ctx: AudioContext, source: AudioNode, smoothing = 0.2) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    // Low smoothing so the loudness envelope tracks syllables (dips between
    // sounds) instead of staying high → the mouth actually closes while talking.
    // Per-avatar tunable from the Lip-sync calibration panel.
    this.analyser.smoothingTimeConstant = smoothing;
    source.connect(this.analyser);
    this.time = new Uint8Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
  }

  sample(): MouthCue {
    this.analyser.getByteTimeDomainData(this.time);
    this.analyser.getByteFrequencyData(this.freq);

    // RMS loudness.
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.time.length);

    // Calibrated jaw: noise-gated so quiet gaps close the mouth; gamma>1 keeps
    // soft consonants low and only vowels open wide. ~0 at rms .045, ~1 at .22.
    const norm = clamp01((rms - 0.045) / 0.175);
    const target = Math.pow(norm, 1.3);
    // Asymmetric smoothing: open fast, close fast so lips meet between syllables.
    const k = target > this.jaw ? 0.6 : 0.5;
    this.jaw += (target - this.jaw) * k;
    if (this.jaw < 0.05) this.jaw = 0; // fully closed when quiet

    // Spectral centroid → vowel color, scaled by how open the mouth is.
    let num = 0;
    let den = 0;
    for (let i = 0; i < this.freq.length; i++) {
      num += i * this.freq[i];
      den += this.freq[i];
    }
    const centroid = den > 0 ? num / den / this.freq.length : 0; // 0..1
    const wide = clamp01((centroid - 0.35) * 2.2) * this.jaw;
    const round = clamp01((0.35 - centroid) * 2.2) * this.jaw;

    return { jawOpen: this.jaw, mouthWide: wide, mouthRound: round, mouthClose: 0 };
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
