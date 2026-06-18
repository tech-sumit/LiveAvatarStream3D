import { Hono } from 'hono';
import { JobProgressWebhook } from '@las/protocol';
import type { Env } from '../env.js';
import { newId, now } from '../lib/ids.js';

export const internal = new Hono<{ Bindings: Env }>();

/** Progress webhook from GPU services (shared internal token; no user auth). */
internal.post('/api/internal/jobs/progress', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${c.env.INTERNAL_SERVICE_TOKEN}`) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const body = JobProgressWebhook.parse(await c.req.json());

  // On terminal success, wipe any stale error from a failed-then-retried
  // attempt; otherwise keep/set it via COALESCE.
  await c.env.DB.prepare(
    "UPDATE jobs SET status = ?, output_key = COALESCE(?, output_key), error = CASE WHEN ? = 'succeeded' THEN NULL ELSE COALESCE(?, error) END, updated_at = ? WHERE id = ?",
  )
    .bind(body.status, body.outputKey ?? null, body.status, body.error ?? null, now(), body.jobId)
    .run();

  const eventId = newId('evt');
  await c.env.DB.prepare(
    'INSERT INTO job_events (id, job_id, kind, status, progress, message, data_json, at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(
      eventId,
      body.jobId,
      body.error ? 'error' : 'stage_progress',
      body.status,
      body.progress ?? null,
      body.message ?? null,
      body.outputKey ? JSON.stringify({ outputKey: body.outputKey }) : null,
      now(),
    )
    .run();

  const stub = c.env.JOB_DO.get(c.env.JOB_DO.idFromName(body.jobId));
  await stub
    .fetch('https://do/append', {
      method: 'POST',
      body: JSON.stringify({
        id: eventId,
        jobId: body.jobId,
        kind: body.error ? 'error' : 'stage_progress',
        status: body.status,
        progress: body.progress,
        message: body.message,
        data: body.outputKey ? { outputKey: body.outputKey } : undefined,
        at: now(),
      }),
    })
    .catch(() => undefined);

  return c.json({ ok: true });
});
