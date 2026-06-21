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
