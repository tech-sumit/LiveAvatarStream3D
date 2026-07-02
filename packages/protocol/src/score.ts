import { z } from 'zod';
import { CAMERA_SHOT_IDS } from '@las/performer-core';

export const Ref = z.string(); // Stage mark/target id, OR 'self.face'/'self.chest'/'self.root', OR a savedShot id
const Vec3 = z.tuple([z.number(), z.number(), z.number()]); // local — `Vec3` is publicly owned by stage.ts
export const Ease = z.enum(['linear', 'ease_in', 'ease_out', 'ease_in_out']);
export const WordAnchor = z.object({ word: z.number().int().min(0) }); // index into the beat's words
export const ShotSize = z.enum(['cu', 'mcu', 'medium', 'wide']); // NAMED — presets.ts imports this
export type ShotSize = z.infer<typeof ShotSize>;
export const Gait = z.enum(['walk', 'stride']);
export const GestureKind = z.enum([
  'none',
  'wave',
  'point',
  'present',
  'count',
  'clasp',
  'nod',
  'openPalms',
  'thumbsUp',
  'shrug',
  'handToChest',
  'explain',
]);
export type GestureKind = z.infer<typeof GestureKind>;
export const EmotionPreset = z.enum([
  'neutral',
  'warm',
  'happy',
  'excited',
  'serious',
  'concerned',
  'sad',
  'confident',
  'thoughtful',
  'surprised',
]);
export type EmotionPreset = z.infer<typeof EmotionPreset>;
// Internal to the Score grammar; NOT re-exported (dsl.ts already owns the public `CameraMove`).
const CameraMove = z.enum(['dolly', 'orbit', 'pan', 'truck', 'pedestal']);

export const CameraDirective = z.union([
  z.object({
    frame: z.object({
      subjects: z.array(Ref).min(1),
      size: ShotSize.optional(),
      height: z.number().optional(),
      balance: z.number().optional(),
      lens: z.number().optional(),
    }),
    follow: z.boolean().optional(),
  }),
  z.object({ shot: z.string() }), // SavedShot id
  // An explicit, authored camera pose — direction as DATA, not a preset. The framing values
  // (where the camera sits / aims, the fov) live in the score JSON, so a composition like the
  // anchor-beside-the-video-wall two-shot is tuned in the script rather than in engine code.
  z.object({ pose: z.object({ pos: Vec3, target: Vec3, fov: z.number().positive() }) }),
  // A named shot-preset from the shared @las/performer-core catalog (the same data the live
  // #shot dropdown and the legacy cam.<id> cue types read). The runtime resolves it against
  // the LIVE avatar (head-height-correct, push-in progression, dutch roll) via the keyframe's
  // `preset` field — the compiler only snapshots an approximate pose for preset-less consumers.
  z.object({ preset: z.enum(CAMERA_SHOT_IDS) }),
  z.object({ move: CameraMove, amount: z.number(), ease: Ease.optional() }), // relative dolly/orbit/pan/truck/pedestal
]);

export const Cue = z.union([
  z.object({
    at: WordAnchor.optional(),
    move: z.object({ to: Ref, gait: Gait.optional(), speed: z.number().optional() }),
  }),
  z.object({ at: WordAnchor.optional(), turn: z.object({ to: z.union([Ref, z.number()]) }) }),
  z.object({
    at: WordAnchor.optional(),
    gesture: z.object({
      kind: GestureKind,
      target: Ref.optional(),
      hand: z.enum(['auto', 'left', 'right']).optional(),
      count: z.number().optional(),
      hold: z.number().optional(),
      amount: z.number().optional(),
    }),
  }),
  z.object({ at: WordAnchor.optional(), look: z.object({ at: Ref }) }),
  z.object({ at: WordAnchor.optional(), camera: CameraDirective }),
  z.object({
    at: WordAnchor.optional(),
    emote: z.object({ emotion: EmotionPreset, intensity: z.number().min(0).max(1).optional() }),
  }), // spec §8 emote(emotion, intensity)
]);

export const ScoreBeat = z.object({
  text: z.string(),
  emphasis: z.array(z.string()).optional(),
  emotion: EmotionPreset.optional(),
  cues: z.array(Cue).default([]),
  pauseMsAfter: z.number().optional(),
});

export const ScoreDefaults = z.object({
  emotion: EmotionPreset.optional(),
  gait: Gait.optional(),
  camera: CameraDirective.optional(),
});

export const Score = z.object({
  stage: z.string(),
  defaults: ScoreDefaults.optional(),
  beats: z.array(ScoreBeat).min(1),
});

export type Score = z.infer<typeof Score>;
export type Cue = z.infer<typeof Cue>;
export type CameraDirective = z.infer<typeof CameraDirective>;
export type ScoreBeat = z.infer<typeof ScoreBeat>;
export type Ref = z.infer<typeof Ref>;
export type WordAnchor = z.infer<typeof WordAnchor>;

// audioTimings: the per-word timing the compiler consumes (minimal, settled here)
export const WordTiming = z.object({ word: z.string(), startSec: z.number(), endSec: z.number() });
export const BeatTiming = z.object({
  startSec: z.number(),
  endSec: z.number(),
  words: z.array(WordTiming).default([]),
});
export const AudioTimings = z.object({ beats: z.array(BeatTiming) });
export type AudioTimings = z.infer<typeof AudioTimings>;

export function validateScore(input: unknown): Score {
  return Score.parse(input);
}
