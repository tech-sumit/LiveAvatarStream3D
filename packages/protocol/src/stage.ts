import { z } from 'zod';
import { PostProcessingSpec } from './newsreport.js';

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

export const TargetRef = z.string(); // a Target/Mark id (Mark.facing / look may reference one)

export const Mark = z.object({
  id: z.string(),
  pos: Vec3,
  facing: z.union([z.number(), TargetRef]).optional(),
});

export const Target = z.object({
  id: z.string(),
  kind: z.enum(['prop', 'anchorBody', 'point']),
  pos: Vec3.optional(),
  node: z.string().optional(),
});

export const SavedShot = z.object({
  id: z.string(),
  pose: z.object({ pos: Vec3, target: Vec3, fov: z.number().positive().finite() }),
});

export const CameraNode = z.object({
  id: z.string(),
  pos: Vec3,
  target: Vec3.optional(),
  fov: z.number().positive().finite().default(35),
});

export const LightNode = z.object({
  id: z.string(),
  kind: z.enum(['key', 'fill', 'rim', 'ambient']),
  intensity: z.number(),
  color: z.number().optional(),
  pos: Vec3.optional(),
});

export const PropNode = z.object({
  id: z.string(),
  node: z.string().optional(),
  pos: Vec3.optional(),
});

export const Stage = z.object({
  id: z.string(),
  marks: z.array(Mark).default([]),
  targets: z.array(Target).default([]),
  cameras: z.array(CameraNode).default([]),
  lights: z.array(LightNode).default([]),
  props: z.array(PropNode).default([]),
  look: PostProcessingSpec.optional(),
  savedShots: z.array(SavedShot).default([]),
});

export type Stage = z.infer<typeof Stage>;
export type Mark = z.infer<typeof Mark>;
export type Target = z.infer<typeof Target>;
export type SavedShot = z.infer<typeof SavedShot>;
export type CameraNode = z.infer<typeof CameraNode>;
export type LightNode = z.infer<typeof LightNode>;
export type PropNode = z.infer<typeof PropNode>;
