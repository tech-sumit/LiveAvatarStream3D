import type { AudioCue } from '@las/protocol';
import { resolveAssetUrl } from '../storage/r2.js';

/** A scheduled non-narration clip (music bed / sfx) for the mixdown. */
export interface AudioClip {
  buffer: AudioBuffer;
  start: number; // seconds on the timeline
  volume: number; // 0..1
  fadeIn: number; // seconds
  fadeOut: number; // seconds
  /** Play only the first N seconds of the buffer (a timeline cue shorter than its file —
   *  mirrors the live scheduler's `min(buffer.duration, cue.duration)` clamp). Default: whole buffer. */
  durationSec?: number;
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
  for (const c of opts.cues) schedule(ctx, c.buffer, c.start, c.volume, c.fadeIn, c.fadeOut, c.durationSec);

  return ctx.startRendering();
}

function schedule(
  ctx: OfflineAudioContext,
  buffer: AudioBuffer,
  startSec: number,
  volume: number,
  fadeIn: number,
  fadeOut: number,
  durationSec?: number,
): void {
  const src = ctx.createBufferSource();
  src.buffer = buffer; // resampled to ctx.sampleRate automatically if rates differ
  const g = ctx.createGain();
  const playLen = Math.min(buffer.duration, durationSec ?? buffer.duration);
  const end = startSec + playLen;
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
  src.start(startSec, 0, playLen);
}

/**
 * Map a protocol {@link AudioCue} (music bed / SFX, carrying a `src` URL + timeline placement)
 * onto a mixdown {@link AudioClip} once its buffer has been decoded. Pure field projection — the
 * decode (the only browser-dependent step) is {@link fetchDecodeAudio}, kept separate so this is
 * unit-testable without an AudioContext.
 */
export function clipFromCue(cue: AudioCue, buffer: AudioBuffer): AudioClip {
  return {
    buffer,
    start: cue.start,
    volume: cue.volume,
    fadeIn: cue.fadeIn,
    fadeOut: cue.fadeOut,
    // AudioCue.duration defaults to 0 = "unspecified" → play the whole buffer (clamping to 0
    // would render the clip silent). A positive duration clamps like the live scheduler.
    ...(cue.duration > 0 ? { durationSec: cue.duration } : {}),
  };
}

/** Fetch + decode one cue source into an AudioBuffer. No retries — failures surface loudly.
 *  An AudioCue.src may be a bare R2 key (authored newscasts store keys) — resolveAssetUrl. */
async function fetchDecodeAudio(src: string, ctx: BaseAudioContext): Promise<AudioBuffer> {
  const res = await fetch(resolveAssetUrl(src));
  if (!res.ok) throw new Error(`offlineAudio: fetch ${res.status} ${res.statusText} for ${src}`);
  const data = await res.arrayBuffer();
  return ctx.decodeAudioData(data);
}

/**
 * Resolve a Performance's audio cues (beds/SFX) into mixdown-ready {@link AudioClip}s by
 * fetching + decoding each `src`. This is the {@link Performance.audio} consumer the offline
 * exporter wires in so authored newscast audio reaches the muxed MP4 (not only the live preview).
 * Decodes run concurrently; any failure rejects (no silent drop, no retry).
 */
export async function audioCuesToClips(
  cues: readonly AudioCue[],
  ctx: BaseAudioContext,
): Promise<AudioClip[]> {
  return Promise.all(cues.map(async (cue) => clipFromCue(cue, await fetchDecodeAudio(cue.src, ctx))));
}
