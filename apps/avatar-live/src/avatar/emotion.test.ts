import { describe, it, expect } from 'vitest';
import { emotionBias, type EmotionName, type EmotionBias } from './emotion.js';

// ─────────────────────────────────────────────────────────────────────────────
// emotion.ts characterization — the emotion → face-bias table layered on top of
// live lipsync. The exact numbers ARE the product (how "happy" the avatar looks),
// so the full table is pinned: any retune shows up as an explicit diff here
// instead of a silent change to every rendered take.
// ─────────────────────────────────────────────────────────────────────────────

describe('emotionBias — the full vocabulary table (intensity 1)', () => {
  const TABLE: Record<EmotionName, EmotionBias> = {
    neutral: { smile: 0.05, frown: 0, browRaise: 0 },
    warm: { smile: 0.35, frown: 0, browRaise: 0.05 },
    happy: { smile: 0.6, frown: 0, browRaise: 0.15 },
    excited: { smile: 0.7, frown: 0, browRaise: 0.4 },
    serious: { smile: 0, frown: 0.15, browRaise: 0 },
    concerned: { smile: 0, frown: 0.4, browRaise: 0.25 },
    sad: { smile: 0, frown: 0.55, browRaise: 0.2 },
    confident: { smile: 0.25, frown: 0, browRaise: 0.1 },
    thoughtful: { smile: 0.05, frown: 0.1, browRaise: 0.15 },
    surprised: { smile: 0.1, frown: 0, browRaise: 0.7 },
  };

  for (const [name, expected] of Object.entries(TABLE) as [EmotionName, EmotionBias][]) {
    it(`${name} → smile ${expected.smile}, frown ${expected.frown}, browRaise ${expected.browRaise}`, () => {
      expect(emotionBias(name)).toEqual(expected);
    });
  }

  it('every emotion channel stays within [0, 1] at full intensity', () => {
    for (const name of Object.keys(TABLE) as EmotionName[]) {
      const b = emotionBias(name);
      for (const v of [b.smile, b.frown, b.browRaise]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('emotionBias — intensity scaling', () => {
  it('scales every channel linearly', () => {
    const half = emotionBias('excited', 0.5);
    expect(half.smile).toBeCloseTo(0.35, 10);
    expect(half.frown).toBeCloseTo(0, 10);
    expect(half.browRaise).toBeCloseTo(0.2, 10);
  });

  it('intensity 0 zeroes the bias (no residual expression)', () => {
    expect(emotionBias('sad', 0)).toEqual({ smile: 0, frown: 0, browRaise: 0 });
  });

  it('intensity defaults to 1', () => {
    expect(emotionBias('happy')).toEqual(emotionBias('happy', 1));
  });
});

describe('emotionBias — unknown name fallback', () => {
  it('falls back to the neutral row instead of throwing', () => {
    // Pinned: doc-driven emotion strings reach this at runtime; an unrecognized
    // name must degrade to neutral, not crash the face rig.
    expect(emotionBias('menacing' as EmotionName)).toEqual(emotionBias('neutral'));
  });
});
