import { describe, it, expect } from 'vitest';
import { parseScript } from './dsl.js';
import {
  compileManifest,
  resolveMontage,
  EMOTION_TO_A2F,
  PerformanceManifest,
  type StageSpec,
  type AudioRef,
} from './manifest.js';

const stage: StageSpec = {
  level: 'L_Stage',
  lighting: 'three_point_warm',
  metahumanId: 'MH_Ada',
};
const audio: AudioRef = { r2Key: 'work/job1/audio.wav', durationS: 6.5, sampleRate: 48000 };

describe('montage resolution', () => {
  it('routes gestures and postures onto the three POC montages', () => {
    expect(resolveMontage('explain', 'neutral')).toBe('M_Explain');
    expect(resolveMontage('nod', 'neutral')).toBe('M_Nod');
    expect(resolveMontage('hand_to_chest', 'neutral')).toBe('M_LeanIn');
    expect(resolveMontage('none', 'leaning_in')).toBe('M_LeanIn');
    expect(resolveMontage('none', 'neutral')).toBeNull();
  });
});

describe('compileManifest', () => {
  it('lays out absolute timing and carries camera cues forward', () => {
    const script = parseScript({
      segments: [
        {
          seq: 0,
          text: 'Hello there.',
          emotion: 'warm',
          gesture: 'wave',
          posture: 'leaning_in',
          pause_ms_after: 500,
          camera: { shot: 'medium_close', move: 'dolly_in', target: 'face' },
        },
        { seq: 1, text: 'Let me explain.', emotion: 'confident', gesture: 'explain' },
        { seq: 2, text: 'Got it?', emotion: 'happy', gesture: 'nod' },
      ],
    });
    const m = compileManifest({
      jobId: 'job1',
      script,
      stage,
      audio,
      timings: [{ durationS: 1.0 }, { durationS: 2.0 }, { durationS: 1.5 }],
    });

    expect(() => PerformanceManifest.parse(m)).not.toThrow();
    expect(m.beats).toHaveLength(3);
    // beat0: 0..1, then 0.5s pause -> beat1 starts at 1.5
    expect(m.beats[0]?.startS).toBe(0);
    expect(m.beats[0]?.endS).toBe(1.0);
    expect(m.beats[1]?.startS).toBe(1.5);
    expect(m.beats[2]?.startS).toBe(3.5);
    expect(m.durationS).toBeCloseTo(5.0, 5);

    // face drive resolves through the A2F map
    expect(m.beats[0]?.face.a2fEmotion).toBe(EMOTION_TO_A2F.warm.a2f);
    // body montage resolves
    expect(m.beats[2]?.body.montageId).toBe('M_Nod');

    // camera: beat0 sets dolly_in; beats 1-2 inherit it (no cue of their own)
    expect(m.camera[0]?.move).toBe('dolly_in');
    expect(m.camera[1]?.move).toBe('dolly_in');
    expect(m.camera[2]?.move).toBe('dolly_in');
    // shot span includes the trailing pause on beat0
    expect(m.camera[0]?.durationS).toBeCloseTo(1.5, 5);
  });

  it('throws when timings do not match segment count', () => {
    const script = parseScript({ segments: [{ seq: 0, text: 'hi' }] });
    expect(() =>
      compileManifest({ jobId: 'j', script, stage, audio, timings: [] }),
    ).toThrow();
  });
});
