// A timeline of ARKit blendshape weights over time. This is exactly the shape of
// NVIDIA Audio2Face-3D output: the gRPC stream returns a header listing
// `blend_shapes` (names) and then `blend_shape_weights` frames of
// `{ time_code, values[] }`. We flatten that to { names, frames:[{t, weights}] }.
export interface BlendshapeTimeline {
  names: string[]; // ARKit blendshape names, index-aligned with each frame's weights
  frames: { t: number; weights: number[] }[]; // t in seconds (ascending)
  fps?: number;
}

// Samples a blendshape timeline at an arbitrary audio time, interpolating between
// the surrounding key frames. Returns a name→weight map ready for applyNamed().
export class BlendshapeTimelineLipsync {
  private last = 0;

  constructor(private timeline: BlendshapeTimeline) {}

  get duration(): number {
    const f = this.timeline.frames;
    return f.length ? f[f.length - 1].t : 0;
  }

  sampleAt(t: number): Record<string, number> {
    const { names, frames } = this.timeline;
    const out: Record<string, number> = {};
    if (!frames.length) return out;

    // Frames are time-ordered; scan from the last index (audio advances forward).
    let i = this.last;
    if (t < frames[i].t) i = 0;
    while (i < frames.length - 1 && frames[i + 1].t <= t) i++;
    this.last = i;

    const a = frames[i];
    const b = frames[Math.min(i + 1, frames.length - 1)];
    const span = b.t - a.t;
    const f = span > 1e-6 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;

    for (let k = 0; k < names.length; k++) {
      const av = a.weights[k] ?? 0;
      const bv = b.weights[k] ?? 0;
      out[names[k]] = av + (bv - av) * f;
    }
    return out;
  }
}
