import { Hono } from 'hono';
import { BuildAvatarRequest, type QueueMessage } from '@las/protocol';
import type { Env } from '../env.js';
import { ensureUser, rowToAvatar } from '../lib/db.js';
import { newId, now } from '../lib/ids.js';

export const avatars = new Hono<{ Bindings: Env }>();

avatars.get('/api/avatars', async (c) => {
  const userId = c.req.query('userId') ?? 'demo-user';
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM avatars WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(userId)
    .all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(results.map((r) => rowToAvatar(r as any)));
});

avatars.post('/api/avatars', async (c) => {
  const body = BuildAvatarRequest.parse(await c.req.json());
  await ensureUser(c.env, body.userId);

  const id = newId('av');
  const r2Prefix = `${body.userId}/${id}`;
  await c.env.DB.prepare(
    'INSERT INTO avatars (id, user_id, label, source_type, status, tier, r2_prefix, has_lora, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(id, body.userId, body.label ?? 'Untitled avatar', body.sourceType, 'building', body.tier, r2Prefix, 0, now())
    .run();

  // Build on the GPU plane via the job queue (not a request waitUntil, which the
  // Worker can evict mid-build and leave the row stuck 'building'). The queue
  // consumer calls /avatar-build/build and flips the row to ready/failed.
  const spec = {
    avatarId: id,
    userId: body.userId,
    sourceType: body.sourceType,
    sourceKey: body.sourceKey,
    prompt: body.prompt,
    tier: body.tier,
    fineTune: body.fineTune,
    outPrefix: r2Prefix,
  };
  await c.env.JOBS.send({ jobId: id, kind: 'avatar_build', userId: body.userId, spec } satisfies QueueMessage);

  const row = await c.env.DB.prepare('SELECT * FROM avatars WHERE id = ?').bind(id).first();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(rowToAvatar(row as any));
});
