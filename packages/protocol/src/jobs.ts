import { z } from 'zod';
import { Script } from './dsl.js';
import { AvatarTier } from './avatar.js';

/** Kinds of GPU work the orchestrator can dispatch. */
export const JobKind = z.enum([
  'health_check',
  'avatar_build',
  'voice_clone',
  'offline_render',
]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum([
  'queued',
  'running',
  'tts',
  'talking_head',
  'finishing',
  // 3D-engine path statuses (additive).
  'compiling',
  'rendering',
  'succeeded',
  'failed',
]);
export type JobStatus = z.infer<typeof JobStatus>;

/** The payload for an offline video render. */
export const OfflineRenderSpec = z.object({
  avatarId: z.string(),
  voiceId: z.string(),
  script: Script,
  tier: AvatarTier.default('premium'),
  /** Target output frame rate after RIFE interpolation. */
  fps: z.number().int().min(24).max(60).default(30),
});
export type OfflineRenderSpec = z.infer<typeof OfflineRenderSpec>;

export const Job = z.object({
  id: z.string(),
  userId: z.string(),
  kind: JobKind,
  status: JobStatus,
  /** Kind-specific payload (validated by the relevant schema downstream). */
  spec: z.unknown(),
  /** R2 key of the result, when succeeded. */
  outputKey: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Job = z.infer<typeof Job>;

/** Body of POST /jobs for an offline render. */
export const CreateRenderJobRequest = z.object({
  userId: z.string(),
  spec: OfflineRenderSpec,
});
export type CreateRenderJobRequest = z.infer<typeof CreateRenderJobRequest>;

/** Message placed on the Cloudflare Queue for the orchestrator consumer. */
export const QueueMessage = z.object({
  jobId: z.string(),
  kind: JobKind,
  userId: z.string(),
  spec: z.unknown(),
});
export type QueueMessage = z.infer<typeof QueueMessage>;
