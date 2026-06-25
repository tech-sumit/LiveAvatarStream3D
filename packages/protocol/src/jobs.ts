import { z } from 'zod';

/** Kinds of GPU work the orchestrator can dispatch. */
export const JobKind = z.enum([
  'health_check',
  'avatar_build',
  'voice_clone',
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

/** Message placed on the Cloudflare Queue for the orchestrator consumer. */
export const QueueMessage = z.object({
  jobId: z.string(),
  kind: JobKind,
  userId: z.string(),
  spec: z.unknown(),
});
export type QueueMessage = z.infer<typeof QueueMessage>;
