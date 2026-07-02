import { Hono } from 'hono';
import { CloneVoiceRequest, type QueueMessage } from '@las/protocol';
import type { Env } from '../env.js';
import { ensureUser, insertJob, rowToVoice } from '../lib/db.js';
import { newId, now } from '../lib/ids.js';
import { bucket } from '../lib/r2.js';

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
    'INSERT INTO voices (id, user_id, label, status, engine, r2_prefix, language, sample_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      body.userId,
      body.label ?? 'Untitled voice',
      'cloning',
      body.engine,
      r2Prefix,
      body.language,
      body.sampleKey,
      now(),
    )
    .run();

  // Clone on the GPU plane via the durable job queue (not a request waitUntil,
  // which Cloudflare can evict once the response returns and leave the row stuck
  // 'cloning'). The queue consumer calls /voice/clone and flips the row to
  // ready/failed. The paired jobs row is the durable operator record
  // (GET /api/jobs, retry).
  const spec = {
    voiceId: id,
    userId: body.userId,
    sampleKey: body.sampleKey,
    engine: body.engine,
    language: body.language,
    outPrefix: r2Prefix,
  };
  const jobId = await insertJob(c.env, body.userId, 'voice_clone', spec);
  await c.env.JOBS.send({ jobId, kind: 'voice_clone', userId: body.userId, spec } satisfies QueueMessage);

  const row = await c.env.DB.prepare('SELECT * FROM voices WHERE id = ?').bind(id).first();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(rowToVoice(row as any));
});

/** Re-enqueue a failed or stuck voice clone (requires sample_key on the row). */
voices.post('/api/voices/:id/retry', async (c) => {
  const id = c.req.param('id');
  const userId = c.req.query('userId') ?? 'demo-user';
  const row = await c.env.DB.prepare('SELECT * FROM voices WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first();
  if (!row) return c.json({ error: 'voice not found' }, 404);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = row as any;
  if (!v.sample_key) {
    return c.json({ error: 'no sample on file — upload a new sample in Clone new' }, 400);
  }
  if (v.status === 'ready') {
    return c.json({ error: 'voice is already ready' }, 400);
  }

  await c.env.DB.prepare('UPDATE voices SET status = ?, error = NULL WHERE id = ?')
    .bind('cloning', id)
    .run();

  const spec = {
    voiceId: id,
    userId: v.user_id,
    sampleKey: v.sample_key,
    engine: v.engine,
    language: v.language,
    outPrefix: v.r2_prefix,
  };
  const jobId = await insertJob(c.env, v.user_id, 'voice_clone', spec);
  await c.env.JOBS.send({ jobId, kind: 'voice_clone', userId: v.user_id, spec } satisfies QueueMessage);

  const updated = await c.env.DB.prepare('SELECT * FROM voices WHERE id = ?').bind(id).first();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(rowToVoice(updated as any));
});

/** Remove a voice profile and its cloned R2 assets (everything under the row's r2_prefix). */
voices.delete('/api/voices/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.req.query('userId') ?? 'demo-user';
  const row = await c.env.DB.prepare('SELECT id, r2_prefix FROM voices WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first();
  if (!row) return c.json({ error: 'voice not found' }, 404);

  // Purge the cloned voice's R2 objects BEFORE dropping the row, so a delete never orphans
  // storage. Paginate list→delete (R2 lists in pages; delete takes up to 1000 keys per call).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prefix = (row as any).r2_prefix as string | null;
  let deletedObjects = 0;
  if (prefix) {
    const voicesBucket = bucket(c.env, 'voices');
    let cursor: string | undefined;
    do {
      const listed = await voicesBucket.list({ prefix, cursor });
      if (listed.objects.length > 0) {
        await voicesBucket.delete(listed.objects.map((o) => o.key));
        deletedObjects += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  await c.env.DB.prepare('DELETE FROM voices WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return c.json({ ok: true, id, deletedObjects });
});
