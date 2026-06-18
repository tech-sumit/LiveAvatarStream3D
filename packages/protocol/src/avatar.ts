import { z } from 'zod';

export const AvatarSourceType = z.enum(['reference_video', 'image_upload', 'generated']);
export type AvatarSourceType = z.infer<typeof AvatarSourceType>;

export const AvatarTier = z.enum(['fast', 'premium']);
export type AvatarTier = z.infer<typeof AvatarTier>;

export const AvatarStatus = z.enum([
  'pending',
  'building',
  'fine_tuning',
  'ready',
  'failed',
]);
export type AvatarStatus = z.infer<typeof AvatarStatus>;

/**
 * The persisted result of the avatar-build pipeline. Blobs live in R2 under
 * `r2Prefix`; this metadata row lives in D1.
 */
export const AvatarProfile = z.object({
  id: z.string(),
  userId: z.string(),
  label: z.string().default('Untitled avatar'),
  sourceType: AvatarSourceType,
  status: AvatarStatus,
  tier: AvatarTier.default('premium'),
  r2Prefix: z.string(),
  /** ArcFace identity embedding dimensionality, if computed. */
  identityDim: z.number().int().optional(),
  hasLora: z.boolean().default(false),
  /** Reference video duration in seconds, when applicable. */
  refDurationS: z.number().optional(),
  createdAt: z.number().int(),
});
export type AvatarProfile = z.infer<typeof AvatarProfile>;

/** Request body for building an avatar from an uploaded reference video. */
export const BuildAvatarRequest = z.object({
  userId: z.string(),
  label: z.string().optional(),
  sourceType: AvatarSourceType,
  /** R2 key of the uploaded reference video / image. */
  sourceKey: z.string(),
  /** Optional text prompt when sourceType is `generated`. */
  prompt: z.string().optional(),
  tier: AvatarTier.default('premium'),
  fineTune: z.boolean().default(false),
});
export type BuildAvatarRequest = z.infer<typeof BuildAvatarRequest>;
