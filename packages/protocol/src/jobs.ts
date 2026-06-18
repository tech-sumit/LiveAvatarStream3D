import { z } from 'zod';
import { Script } from './dsl.js';
import { AvatarTier } from './avatar.js';
import { Resolution } from './manifest.js';

/** Kinds of GPU work the orchestrator can dispatch. */
export const JobKind = z.enum([
  'health_check',
  'avatar_build',
  'voice_clone',
  'offline_render',
  // 3D-engine cinematic path: TTS -> performance manifest -> UE5 Movie Render
  // Queue on an RTX/L40S node. See docs/specs/2026-06-18-3d-engine-poc.md.
  'engine_render',
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

/**
 * Payload for a 3D-engine cinematic render. Mirrors OfflineRenderSpec but
 * targets the UE5 + MetaHuman + ACE Audio2Face path: the orchestrator runs TTS,
 * compiles a PerformanceManifest, and dispatches it to a UE render node. The
 * `script` may carry per-beat `camera` cues (see dsl.ts CameraCue).
 */
export const EngineRenderSpec = z.object({
  /** MetaHuman blueprint/asset id to drive (engine-side identity). */
  metahumanId: z.string(),
  voiceId: z.string(),
  script: Script,
  stage: z
    .object({
      level: z.string().default('L_Stage'),
      lighting: z.string().default('three_point_warm'),
    })
    .default({}),
  resolution: Resolution.default({}),
  /** Cinematic frame rate for Movie Render Queue. */
  fps: z.number().int().min(24).max(60).default(24),
});
export type EngineRenderSpec = z.infer<typeof EngineRenderSpec>;

/** Body of POST /api/engine-jobs for a 3D-engine cinematic render. */
export const CreateEngineRenderJobRequest = z.object({
  userId: z.string(),
  spec: EngineRenderSpec,
});
export type CreateEngineRenderJobRequest = z.infer<typeof CreateEngineRenderJobRequest>;

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
