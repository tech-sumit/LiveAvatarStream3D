import type { BlendshapeTimeline } from '../lipsync/blendshapeTimeline.js';

// Turns speech audio into an ARKit blendshape timeline. The production client
// calls NVIDIA Audio2Face-3D (via our server wrapper); the local client is a
// GPU-free stand-in for testing the consumer pipeline.
export interface A2FClient {
  readonly kind: 'server' | 'local';
  analyze(audio: AudioBuffer, opts?: { fps?: number }): Promise<BlendshapeTimeline>;
}

// Accept either our normalized shape ({names, frames:[{t,weights}]}) or the
// A2F-native shape ({bsNames, frames:[{timeCode, blendShapes:{name:w}}]}).
export function normalizeTimeline(data: unknown): BlendshapeTimeline {
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.names) && Array.isArray(d.frames) && (d.frames[0] as { weights?: unknown })?.weights) {
    return d as unknown as BlendshapeTimeline;
  }
  // A2F-native: collect the union of blendshape names, then index-align.
  const native = (d.frames ?? d.animation ?? []) as { timeCode?: number; t?: number; blendShapes: Record<string, number> }[];
  const names = (d.bsNames as string[]) ?? unionNames(native);
  return {
    names,
    frames: native.map((fr) => ({
      t: fr.t ?? fr.timeCode ?? 0,
      weights: names.map((n) => fr.blendShapes[n] ?? 0),
    })),
  };
}

function unionNames(frames: { blendShapes: Record<string, number> }[]): string[] {
  const set = new Set<string>();
  for (const fr of frames) for (const n of Object.keys(fr.blendShapes)) set.add(n);
  return [...set];
}
