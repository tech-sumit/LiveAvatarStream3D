import { z } from 'zod';

/**
 * The performance DSL. This is the contract between the director LLM (and the
 * web editor) and the GPU avatar pipeline. It is intentionally flat and
 * enumerated so a model can emit it reliably and stream it segment-by-segment.
 *
 * See ARCHITECTURE.md "DSL -> conditioning mapping".
 */

export const EMOTIONS = [
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
] as const;

export const GESTURES = [
  'none',
  'wave',
  'point',
  'open_palms',
  'count',
  'thumbs_up',
  'nod',
  'shrug',
  'hand_to_chest',
  'explain',
] as const;

export const POSTURES = [
  'neutral',
  'leaning_in',
  'upright',
  'relaxed',
  'turned_slightly',
] as const;

export const Emotion = z.enum(EMOTIONS);
export const Gesture = z.enum(GESTURES);
export const Posture = z.enum(POSTURES);

export type Emotion = z.infer<typeof Emotion>;
export type Gesture = z.infer<typeof Gesture>;
export type Posture = z.infer<typeof Posture>;

/**
 * Camera vocabulary for the 3D-engine path. The director may attach a `camera`
 * cue to a beat to drive a virtual Cine Camera in the engine (Sequencer / Movie
 * Render Queue). The 2D pipeline ignores it; it is purely additive. Like the
 * other vocabularies it is enumerated so the LLM emits it reliably and the
 * engine maps it deterministically. See ARCHITECTURE.md and the 3D-engine POC
 * spec for the cue -> Sequencer mapping.
 */
export const CAMERA_SHOTS = [
  'wide',
  'full',
  'medium',
  'medium_close',
  'close_up',
  'extreme_close_up',
] as const;

export const CAMERA_MOVES = [
  'static',
  'dolly_in',
  'dolly_out',
  'truck_left',
  'truck_right',
  'pan_left',
  'pan_right',
  'pedestal_up',
  'pedestal_down',
  'orbit_left',
  'orbit_right',
] as const;

export const CAMERA_TARGETS = ['eyes', 'face', 'chest', 'torso', 'full_body'] as const;

export const CAMERA_EASINGS = ['linear', 'ease_in', 'ease_out', 'ease_in_out'] as const;

export const CameraShot = z.enum(CAMERA_SHOTS);
export const CameraMove = z.enum(CAMERA_MOVES);
export const CameraTarget = z.enum(CAMERA_TARGETS);
export const CameraEasing = z.enum(CAMERA_EASINGS);

export type CameraShot = z.infer<typeof CameraShot>;
export type CameraMove = z.infer<typeof CameraMove>;
export type CameraTarget = z.infer<typeof CameraTarget>;
export type CameraEasing = z.infer<typeof CameraEasing>;

/** A virtual-camera cue for one beat (3D-engine path only). */
export const CameraCue = z.object({
  shot: CameraShot.default('medium'),
  move: CameraMove.default('static'),
  target: CameraTarget.default('face'),
  easing: CameraEasing.default('ease_in_out'),
  /** Move magnitude 0..1 scaling distance/angle travelled across the beat. */
  intensity: z.number().min(0).max(1).default(0.5),
});
export type CameraCue = z.infer<typeof CameraCue>;

/** One beat of speech plus how it should be performed. */
export const ScriptSegment = z.object({
  /** Monotonic ordering index within a script / turn. */
  seq: z.number().int().nonnegative(),
  /** Optional grouping id, used in realtime to tie segments to a turn. */
  turnId: z.string().optional(),
  /** The words to speak for this beat. */
  text: z.string().min(1).max(2000),
  emotion: Emotion.default('neutral'),
  gesture: Gesture.default('none'),
  posture: Posture.default('neutral'),
  /** Words within `text` to emphasize prosodically. */
  emphasis: z.array(z.string()).default([]),
  /** Pause inserted after this beat, in milliseconds. */
  pause_ms_after: z.number().int().min(0).max(5000).default(0),
  /**
   * Optional virtual-camera cue. Consumed only by the 3D-engine path; the 2D
   * pipeline ignores it. Omitted means "hold the previous shot".
   */
  camera: CameraCue.optional(),
});
export type ScriptSegment = z.infer<typeof ScriptSegment>;

/** A complete offline script. */
export const Script = z.object({
  version: z.literal(1).default(1),
  language: z.string().default('en'),
  segments: z.array(ScriptSegment).min(1),
});
export type Script = z.infer<typeof Script>;

/** A single streamed segment as emitted by the director LLM in realtime. */
export const StreamedSegment = ScriptSegment.extend({
  turnId: z.string(),
  /** True when this is the last segment of the turn. */
  final: z.boolean().default(false),
});
export type StreamedSegment = z.infer<typeof StreamedSegment>;

/** Validate + apply defaults to an unknown script payload. */
export function parseScript(input: unknown): Script {
  return Script.parse(input);
}
