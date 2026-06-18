import { Hono } from 'hono';
import { CreateRenderJobRequest, type QueueMessage } from '@las/protocol';
import type { Env } from '../env.js';
import { ensureUser, rowToJob, rowToJobEvent } from '../lib/db.js';
import { newId, now } from '../lib/ids.js';

export const jobs = new Hono<{ Bindings: Env }>();

/** Create an offline render job and enqueue it. */
jobs.post('/api/jobs', async (c) => {
  const body = CreateRenderJobRequest.parse(await c.req.json());
  await ensureUser(c.env, body.userId);

  const id = newId('job');
  const ts = now();
  await c.env.DB.prepare(
    'INSERT INTO jobs (id, user_id, kind, status, spec_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(id, body.userId, 'offline_render', 'queued', JSON.stringify(body.spec), ts, ts)
    .run();

  const msg: QueueMessage = { jobId: id, kind: 'offline_render', userId: body.userId, spec: body.spec };
  await c.env.JOBS.send(msg);

  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(rowToJob(row as any));
});

/** Enqueue a GPU health-check job (Phase 0 round-trip proof). */
jobs.post('/api/_health/gpu', async (c) => {
  const userId = 'demo-user';
  await ensureUser(c.env, userId);
  const id = newId('job');
  const ts = now();
  await c.env.DB.prepare(
    'INSERT INTO jobs (id, user_id, kind, status, spec_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(id, userId, 'health_check', 'queued', '{}', ts, ts)
    .run();
  await c.env.JOBS.send({ jobId: id, kind: 'health_check', userId, spec: {} } satisfies QueueMessage);
  return c.json({ jobId: id });
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
