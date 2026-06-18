import { Hono } from 'hono';
import { CloneVoiceRequest, type QueueMessage } from '@las/protocol';
import type { Env } from '../env.js';
import { ensureUser, rowToVoice } from '../lib/db.js';
import { newId, now } from '../lib/ids.js';

export const voices = new Hono<{ Bindings: Env }>();

voices.get('/api/voices', async (c) => {
  const userId = c.req.query('userId') ?? 'demo-user';
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM voices WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(userId)
    .all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(results.map((r) => rowToVoice(r as any)));
});

voices.post('/api/voices', async (c) => {
  const body = CloneVoiceRequest.parse(await c.req.json());
  await ensureUser(c.env, body.userId);

  const id = newId('vo');
  const r2Prefix = `${body.userId}/${id}`;
  await c.env.DB.prepare(
    'INSERT INTO voices (id, user_id, label, status, engine, r2_prefix, language, created_at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(id, body.userId, body.label ?? 'Untitled voice', 'cloning', body.engine, r2Prefix, body.language, now())
    .run();

  // Clone on the GPU plane via the durable job queue (not a request waitUntil,
  // which Cloudflare can evict once the response returns and leave the row stuck
  // 'cloning'). The queue consumer calls /voice/clone and flips the row to
  // ready/failed.
  const spec = {
    voiceId: id,
    userId: body.userId,
    sampleKey: body.sampleKey,
    engine: body.engine,
    language: body.language,
    outPrefix: r2Prefix,
  };
  await c.env.JOBS.send({ jobId: id, kind: 'voice_clone', userId: body.userId, spec } satisfies QueueMessage);

  const row = await c.env.DB.prepare('SELECT * FROM voices WHERE id = ?').bind(id).first();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(rowToVoice(row as any));
});
