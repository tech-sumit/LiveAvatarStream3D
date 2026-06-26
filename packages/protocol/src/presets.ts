import type { ShotSize } from './score.js'; // 'cu'|'mcu'|'medium'|'wide'  (named export now exists)
import type { GestureKind } from './score.js';
import type { EmotionPreset } from './score.js';

export const CAMERA_SIZE_PRESET: Record<
  ShotSize,
  { distHeads: number; targetDropHeads: number; fov: number }
> = {
  cu: { distHeads: 4.0, targetDropHeads: 0.25, fov: 30 }, // pins catalog.poseFor('cam.close')
  mcu: { distHeads: 5.2, targetDropHeads: 0.3, fov: 32 },
  medium: { distHeads: 5.5, targetDropHeads: 0.6, fov: 35 },
  wide: { distHeads: 9.0, targetDropHeads: 1.1, fov: 40 }, // pins catalog.poseFor('cam.wide')
};

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
