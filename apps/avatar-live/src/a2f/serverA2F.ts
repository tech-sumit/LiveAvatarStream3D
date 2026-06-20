import type { BlendshapeTimeline } from '../lipsync/blendshapeTimeline.js';
import { audioBufferToWav16kMono } from './wav.js';
import { normalizeTimeline, type A2FClient } from './types.js';

// Production path: POST 16 kHz mono WAV to our server wrapper, which streams it to
// the Audio2Face-3D NIM over gRPC and returns the ARKit blendshape timeline.
// Set VITE_A2F_URL to that endpoint (see services/gpu/a2f).
export class ServerA2FClient implements A2FClient {
  readonly kind = 'server' as const;

  constructor(private endpoint: string) {}

  async analyze(audio: AudioBuffer): Promise<BlendshapeTimeline> {
    const wav = audioBufferToWav16kMono(audio);
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
    });
    if (!res.ok) throw new Error(`A2F server ${res.status}`);
    return normalizeTimeline(await res.json());
  }
}
