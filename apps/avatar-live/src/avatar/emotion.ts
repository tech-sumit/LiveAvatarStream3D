// DSL emotion vocabulary (mirrors packages/protocol dsl.ts) → face channel bias.
// These are added on top of live lipsync so the avatar emotes while it speaks.
export type EmotionName =
  | 'neutral'
  | 'warm'
  | 'happy'
  | 'excited'
  | 'serious'
  | 'concerned'
  | 'sad'
  | 'confident'
  | 'thoughtful'
  | 'surprised';

export interface EmotionBias {
  smile: number;
  frown: number;
  browRaise: number;
}

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

export function emotionBias(name: EmotionName, intensity = 1): EmotionBias {
  const b = TABLE[name] ?? TABLE.neutral;
  return { smile: b.smile * intensity, frown: b.frown * intensity, browRaise: b.browRaise * intensity };
}
