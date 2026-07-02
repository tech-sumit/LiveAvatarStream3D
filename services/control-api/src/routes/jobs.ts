import { Hono } from 'hono';
import type { Job, QueueMessage } from '@las/protocol';
import type { Env } from '../env.js';
import { ensureUser, insertJob, rowToJob, rowToJobEvent } from '../lib/db.js';
import { now } from '../lib/ids.js';

export const jobs = new Hono<{ Bindings: Env }>();

/** Why a job cannot be retried, or null when it can (only failed jobs are retryable). */
export function retryableJobError(job: Pick<Job, 'status'>): string | null {
  return job.status === 'failed' ? null : `job is ${job.status} — only failed jobs can be retried`;
}

/** Enqueue a GPU health-check job (Phase 0 round-trip proof). */
jobs.post('/api/_health/gpu', async (c) => {
  const userId = 'demo-user';
  await ensureUser(c.env, userId);
  const id = await insertJob(c.env, userId, 'health_check', {});
  await c.env.JOBS.send({ jobId: id, kind: 'health_check', userId, spec: {} } satisfies QueueMessage);
  return c.json({ jobId: id });
});

/** Recent jobs, newest first (operator observability; POC scale: last 50). */
jobs.get('/api/jobs', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50',
  ).all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(results.map((r) => rowToJob(r as any)));
});

jobs.get('/api/jobs/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  if (!row) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM job_events WHERE job_id = ? ORDER BY at ASC',
  )
    .bind(id)
    .all();
  return c.json({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    job: rowToJob(row as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: results.map((r) => rowToJobEvent(r as any)),
  });
});

/**
 * Re-enqueue a FAILED job (avatar_build / voice_clone / health_check) with its
 * original spec. Resets the jobs row to queued and mirrors the reset onto the
 * avatar/voice row the studio polls, so the UI shows the rebuild in progress.
 */
jobs.post('/api/jobs/:id/retry', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  if (!row) return c.json({ error: 'job not found' }, 404);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job = rowToJob(row as any);
  const notRetryable = retryableJobError(job);
  if (notRetryable) return c.json({ error: notRetryable }, 400);

  await c.env.DB.prepare("UPDATE jobs SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?")
    .bind(now(), id)
    .run();

  const spec = (job.spec ?? {}) as Record<string, unknown>;
  if (job.kind === 'avatar_build' && typeof spec.avatarId === 'string') {
    await c.env.DB.prepare("UPDATE avatars SET status = 'building' WHERE id = ?").bind(spec.avatarId).run();
  } else if (job.kind === 'voice_clone' && typeof spec.voiceId === 'string') {
    await c.env.DB.prepare("UPDATE voices SET status = 'cloning', error = NULL WHERE id = ?")
      .bind(spec.voiceId)
      .run();
  }

  await c.env.JOBS.send({ jobId: id, kind: job.kind, userId: job.userId, spec: job.spec } satisfies QueueMessage);

  const updated = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json({ job: rowToJob(updated as any) });
});

/** Live updates over WebSocket via the job's Durable Object. */
jobs.get('/api/jobs/:id/subscribe', async (c) => {
  const id = c.req.param('id');
  const stub = c.env.JOB_DO.get(c.env.JOB_DO.idFromName(id));
  return stub.fetch('https://do/subscribe', { headers: c.req.raw.headers });
});

/** Stream the finished mp4 from R2. */
jobs.get('/api/jobs/:id/download', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT output_key FROM jobs WHERE id = ?').bind(id).first<{ output_key: string | null }>();
  if (!row?.output_key) return c.json({ error: 'not ready' }, 404);
  const obj = await c.env.OUTPUTS.get(row.output_key);
  if (!obj) return c.json({ error: 'missing object' }, 404);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'video/mp4',
      'content-disposition': `attachment; filename="${id}.mp4"`,
    },
  });
});
