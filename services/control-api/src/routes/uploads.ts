import { Hono } from 'hono';
import type { Env } from '../env.js';
import { bucket, uploadKeyForBucket, type BucketName } from '../lib/r2.js';
import { ensureUser } from '../lib/db.js';
import { newId } from '../lib/ids.js';

export const uploads = new Hono<{ Bindings: Env }>();

const KIND_BUCKET: Record<string, BucketName> = {
  reference_video: 'assets',
  image: 'assets',
  voice_sample: 'assets',
};

/** Mint an upload target. We proxy uploads through the Worker (see PUT below). */
uploads.post('/api/uploads', async (c) => {
  const { userId, kind } = await c.req.json<{ userId: string; kind: string; contentType?: string }>();
  await ensureUser(c.env, userId);
  const b = KIND_BUCKET[kind] ?? 'assets';
  const key = `${userId}/uploads/${newId(kind)}`;
  const origin = new URL(c.req.url).origin;
  return c.json({ key, bucket: b, url: `${origin}${uploadKeyForBucket(b, key)}` });
});

/** Receive the proxied upload body and stream it into R2. */
uploads.put('/api/uploads/:bucket/*', async (c) => {
  const b = c.req.param('bucket') as BucketName;
  const key = c.req.path.split(`/api/uploads/${b}/`)[1];
  if (!key) return c.json({ error: 'missing key' }, 400);
  const contentType = c.req.header('content-type') ?? 'application/octet-stream';
  await bucket(c.env, b).put(decodeURIComponent(key), c.req.raw.body, {
    httpMetadata: { contentType },
  });
  return c.json({ ok: true, key });
});
