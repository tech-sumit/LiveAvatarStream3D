import { z } from 'zod';
import { JobStatus } from './jobs.js';

/** Progress events emitted by the orchestrator / GPU services, persisted per job. */
export const JobEventKind = z.enum([
  'status_changed',
  'stage_progress',
  'log',
  'result',
  'error',
]);
export type JobEventKind = z.infer<typeof JobEventKind>;

export const JobEvent = z.object({
  id: z.string(),
  jobId: z.string(),
  kind: JobEventKind,
  status: JobStatus.optional(),
  /** 0..1 progress for the current stage. */
  progress: z.number().min(0).max(1).optional(),
  message: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  at: z.number().int(),
});
export type JobEvent = z.infer<typeof JobEvent>;

/**
 * Webhook body GPU services POST back to the control API to report progress.
 * Authenticated with the shared INTERNAL_SERVICE_TOKEN (no user auth yet).
 */
export const JobProgressWebhook = z.object({
  jobId: z.string(),
  status: JobStatus,
  progress: z.number().min(0).max(1).optional(),
  message: z.string().optional(),
  outputKey: z.string().optional(),
  error: z.string().optional(),
});
export type JobProgressWebhook = z.infer<typeof JobProgressWebhook>;
