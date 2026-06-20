import type { BlendshapeTimeline } from '../lipsync/blendshapeTimeline.js';
import type { A2FClient } from './types.js';

// GPU-free stand-in for Audio2Face-3D: derives a coarse ARKit blendshape timeline
// from audio loudness (jaw) and zero-crossing rate (vowel brightness → wide vs
// round). It emits the SAME timeline format as the real NIM, so the consumer
// pipeline (BlendshapeTimelineLipsync + applyNamed) is identical — only the
// quality differs. Swap in ServerA2FClient (VITE_A2F_URL) for true A2F output.
const NAMES = [
  'jawOpen',
  'mouthClose',
  'mouthFunnel',
  'mouthPucker',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
];

export class LocalA2FClient implements A2FClient {
  readonly kind = 'local' as const;

  async analyze(audio: AudioBuffer, opts?: { fps?: number }): Promise<BlendshapeTimeline> {
    const fps = opts?.fps ?? 30;
    const data = audio.getChannelData(0);
    const sr = audio.sampleRate;
    const win = Math.floor(sr * 0.045);
    const frameCount = Math.max(1, Math.ceil(audio.duration * fps));
    const frames: { t: number; weights: number[] }[] = [];
    let jawSmoothed = 0;

    for (let f = 0; f < frameCount; f++) {
      const center = Math.floor((f / fps) * sr);
      const start = Math.max(0, center - win);
      const end = Math.min(data.length, center + win);

      let sumSq = 0;
      let crossings = 0;
      let prev = 0;
      for (let i = start; i < end; i++) {
        const v = data[i];
        sumSq += v * v;
        if ((v >= 0 && prev < 0) || (v < 0 && prev >= 0)) crossings++;
        prev = v;
      }
      const n = Math.max(1, end - start);
      const rms = Math.sqrt(sumSq / n);
      const zcr = crossings / n; // higher → brighter / front vowels

      const jawTarget = rms < 0.015 ? 0 : Math.min(1, Math.pow((rms - 0.015) * 5, 0.8));
      jawSmoothed += (jawTarget - jawSmoothed) * 0.5;

      const bright = Math.min(1, zcr * sr * 0.0009); // normalize ZCR to ~0..1
      const wide = bright * jawSmoothed;
      const round = (1 - bright) * jawSmoothed;

      frames.push({
        t: f / fps,
        weights: [
          jawSmoothed, // jawOpen
          jawSmoothed < 0.06 ? 0.25 : 0, // mouthClose
          round * 0.8, // mouthFunnel
          round * 0.5, // mouthPucker
          wide * 0.6, // mouthStretchLeft
          wide * 0.6, // mouthStretchRight
          wide * 0.2, // mouthSmileLeft
          wide * 0.2, // mouthSmileRight
          jawSmoothed * 0.4, // mouthLowerDownLeft
          jawSmoothed * 0.4, // mouthLowerDownRight
        ],
      });
    }

    return { names: NAMES, frames, fps };
  }
}
