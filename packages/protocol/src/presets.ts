import type { GestureKind } from './score.js';
import type { EmotionPreset } from './score.js';

// NOTE: size→framing presets live in performer-core's composeShot.SIZE_TABLE (the table that
// actually frames the shot, including the bespoke `medium`/cam.anchor offsets). A protocol-side
// CAMERA_SIZE_PRESET previously duplicated this and had DRIFTED for `medium`, so it was removed —
// composeShot is the single source of truth.

export const EMOTION_ENERGY: Record<EmotionPreset, 'low' | 'med' | 'high'> = {
  neutral: 'med',
  warm: 'med',
  confident: 'med',
  happy: 'high',
  excited: 'high',
  surprised: 'high',
  serious: 'low',
  concerned: 'low',
  sad: 'low',
  thoughtful: 'low',
};

// CAMEL-CASE GestureKind (Score/performer-core vocab) → SNAKE_CASE on-disk clip filename (the integration seam).
// null = IK-driven (point/count) or no library clip (none/explain handled by talk-base selection).
export const GESTURE_KIND_TO_CLIP: Record<GestureKind, string | null> = {
  none: null,
  explain: null,
  point: null,
  count: null, // point/count are IK; none/explain use talk-base
  wave: 'wave',
  present: 'open_palms',
  openPalms: 'open_palms',
  thumbsUp: 'thumbs_up',
  shrug: 'shrug',
  handToChest: 'hand_to_chest',
  clasp: 'hand_to_chest',
  nod: 'nod',
};
