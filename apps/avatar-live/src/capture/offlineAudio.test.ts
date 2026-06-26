import { describe, it, expect } from 'vitest';
import { clipFromCue } from './offlineAudio.js';
import type { AudioCue } from '@las/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// The Performance.audio → mixdown consumer. clipFromCue is the pure field
// projection (no AudioContext), so it is unit-testable here; the fetch/decode
// step (audioCuesToClips/fetchDecodeAudio) is browser-only and exercised by the
// studio smoke test. This pins that a bed/SFX cue's timeline placement + gain
// survive onto the AudioClip the offline exporter mixes — the bug this fixes was
// the export passing audioCues: [] so beds never reached the MP4.
// ─────────────────────────────────────────────────────────────────────────────

describe('clipFromCue', () => {
  it('maps a cue’s start/volume/fades onto an AudioClip carrying the decoded buffer', () => {
    const cue = {
      kind: 'bed',
      src: '/samples/bed.mp3',
      start: 2.5,
      volume: 0.3,
      fadeIn: 1,
      fadeOut: 1.5,
      label: 'music bed',
    } as AudioCue;
    const buffer = { duration: 4 } as AudioBuffer;

    const clip = clipFromCue(cue, buffer);

    expect(clip).toEqual({ buffer, start: 2.5, volume: 0.3, fadeIn: 1, fadeOut: 1.5 });
    expect(clip.buffer).toBe(buffer); // exact buffer instance, not a copy
  });

  it('carries an SFX cue with no fades through at its scheduled start', () => {
    const cue = { kind: 'sfx', src: '/sfx/whoosh.mp3', start: 0.5, volume: 0.8, fadeIn: 0, fadeOut: 0 } as AudioCue;
    const buffer = { duration: 1 } as AudioBuffer;

    const clip = clipFromCue(cue, buffer);

    expect(clip.start).toBe(0.5);
    expect(clip.volume).toBe(0.8);
    expect(clip.fadeIn).toBe(0);
    expect(clip.fadeOut).toBe(0);
  });
});
