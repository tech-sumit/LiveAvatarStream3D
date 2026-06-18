import { Hono } from 'hono';
import { CreateEngineRenderJobRequest, type QueueMessage } from '@las/protocol';
import type { Env } from '../env.js';
import { ensureUser, rowToJob } from '../lib/db.js';
import { newId, now } from '../lib/ids.js';

export const engine = new Hono<{ Bindings: Env }>();

/**
 * Create a 3D-engine cinematic render job and enqueue it. Mirrors POST
 * /api/jobs (offline_render) but routes to the UE5 + MetaHuman + ACE
 * Audio2Face path via the `engine_render` job kind. The orchestrator runs TTS,
 * compiles a PerformanceManifest, and dispatches it to a UE render node.
 */
engine.post('/api/engine-jobs', async (c) => {
  const body = CreateEngineRenderJobRequest.parse(await c.req.json());
  await ensureUser(c.env, body.userId);

  const id = newId('job');
  const ts = now();
  await c.env.DB.prepare(
    'INSERT INTO jobs (id, user_id, kind, status, spec_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(id, body.userId, 'engine_render', 'queued', JSON.stringify(body.spec), ts, ts)
    .run();

  const msg: QueueMessage = { jobId: id, kind: 'engine_render', userId: body.userId, spec: body.spec };
  await c.env.JOBS.send(msg);

  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(rowToJob(row as any));
});

/** Fetch the compiled performance manifest for an engine_render job (debug /
 * for a UE node that pulls rather than receives a push). */
engine.get('/api/engine-jobs/:id/manifest', async (c) => {
  const id = c.req.param('id');
  const obj = await c.env.OUTPUTS.get(`work/${id}/manifest.json`);
  if (!obj) return c.json({ error: 'manifest not ready' }, 404);
  return new Response(obj.body, { headers: { 'content-type': 'application/json' } });
});
