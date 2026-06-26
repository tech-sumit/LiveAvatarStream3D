import { z } from 'zod';
import { Vec3 } from './stage.js';
import { GestureKind, EmotionPreset } from './score.js';
import { Posture } from './dsl.js'; // REUSE — do not redefine
import { AudioCue } from './newsreport.js'; // REUSE the existing audio-cue schema

// Late-bound avatar-relative target: resolved per-frame by score.drive against the live GLB.
export const BodyRef = z.object({ bind: z.enum(['face', 'chest', 'root']) });

// Late-bound scene-node target: a node-bound Stage Target (kind 'anchorBody'/'point' with a
// `node` and no `pos`). Carried by name and re-resolved per-frame against the live GLB node —
// NEVER baked to a static [0,0,0] at compile time.
export const NodeRef = z.object({ node: z.string() });

export const ResolvedTargetRef = z.union([
  z.object({ pos: Vec3 }), // static world point (resolved at compile time)
  BodyRef, // tracks the loaded/walked avatar (resolved at runtime)
  NodeRef, // tracks a named live scene node (resolved at runtime)
]);

export const CameraKeyframe = z.object({
  tSec: z.number(),
  pos: Vec3,
  target: Vec3,
  fov: z.number(),
  follow: z.boolean().default(false), // authored snap-follow (the live/export divergence, made explicit)
  followSubjects: z.array(ResolvedTargetRef).optional(), // when follow: re-frame these per-frame (self.* tracks avatar)
  ease: z.enum(['linear', 'ease_in', 'ease_out', 'ease_in_out']).optional(),
  move: z.enum(['dolly', 'orbit', 'pan', 'truck', 'pedestal']).optional(), // present for relative-move keyframes
  moveAmount: z.number().optional(),
});

export const MotionPath = z.object({
  startSec: z.number(),
  endSec: z.number(),
  from: Vec3,
  to: Vec3,
  gait: z.enum(['walk', 'stride']),
  speed: z.number(),
  arriveFacing: z.number().optional(),
});

export const ResolvedTurn = z.object({ tSec: z.number(), yaw: z.number() }); // turn verb → setTurn(yaw)

export const ResolvedGesture = z.object({
  tSec: z.number(),
  kind: GestureKind,
  drive: z.object({
    kind: z.enum(['clip', 'ik', 'none']),
    clip: z.string().optional(),
    ik: z.enum(['aim', 'count']).optional(),
    baseEnergy: z.enum(['low', 'med', 'high']).optional(),
  }), // baseEnergy carried
  target: ResolvedTargetRef.optional(),
  side: z.enum(['left', 'right']).optional(),
  count: z.number().optional(),
  hold: z.number().optional(),
});

export const ResolvedLook = z.object({ tSec: z.number(), target: ResolvedTargetRef }); // self.* looks track the avatar

export const ResolvedEmote = z.object({
  tSec: z.number(),
  emotion: EmotionPreset,
  intensity: z.number().default(1),
});

export const ScreenCut = z.object({ tSec: z.number(), source: z.string() }); // back-wall vision-mixer cut (today's cam.screenSource)

// The 2D-safe per-beat projection (what EchoMimic / MuseTalk read), now carrying emote intensity:
export const BeatProjection = z.object({
  startSec: z.number(),
  endSec: z.number(),
  text: z.string(),
  emotion: EmotionPreset,
  intensity: z.number().default(1),
  gesture: GestureKind,
  posture: Posture,
});

export const Performance = z.object({
  stageId: z.string(),
  durationSec: z.number(),
  beats: z.array(BeatProjection), // absolute-timed + 2D-safe projection
  camera: z.array(CameraKeyframe),
  motion: z.array(MotionPath),
  turns: z.array(ResolvedTurn), // resolved turn verbs
  gestures: z.array(ResolvedGesture),
  looks: z.array(ResolvedLook),
  emotes: z.array(ResolvedEmote), // mid-beat emote anchors
  screen: z.array(ScreenCut), // back-wall montage channel (montage sync preserved)
  audio: z.array(AudioCue), // music beds / SFX (mixdown preserved)
});

export type Performance = z.infer<typeof Performance>;
