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

/** The only buckets this route writes — the ones POST /api/uploads mints. */
const SUPPORTED_BUCKETS = new Set<BucketName>(Object.values(KIND_BUCKET));

/** Reference videos / voice samples stay well under this. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/** userId becomes an R2 key prefix — keep it a single sane path segment. */
const USER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Keys must look like the ones POST /api/uploads mints — `<userId>/uploads/<id>` —
 * so a caller can't write outside a user's uploads/ area: no `..`/`.` segments,
 * no absolute or backslashed keys, no control characters.
 */
function validUploadKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  if (key.startsWith('/') || key.includes('\\')) return false;
  const segments = key.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  return segments.length >= 3 && USER_ID_RE.test(segments[0] ?? '') && segments[1] === 'uploads';
}

/** Mint an upload target. We proxy uploads through the Worker (see PUT below). */
uploads.post('/api/uploads', async (c) => {
  const { userId, kind } = await c.req.json<{ userId: string; kind: string; contentType?: string }>();
  if (!USER_ID_RE.test(userId ?? '')) return c.json({ error: 'invalid userId' }, 400);
  await ensureUser(c.env, userId);
  const b = KIND_BUCKET[kind] ?? 'assets';
  const key = `${userId}/uploads/${newId(kind)}`;
  const origin = new URL(c.req.url).origin;
  return c.json({ key, bucket: b, url: `${origin}${uploadKeyForBucket(b, key)}` });
});

/** Receive the proxied upload body and stream it into R2. */
uploads.put('/api/uploads/:bucket/*', async (c) => {
  const b = c.req.param('bucket') as BucketName;
  if (!SUPPORTED_BUCKETS.has(b)) return c.json({ error: 'unsupported bucket' }, 400);
  const rawKey = c.req.path.split(`/api/uploads/${b}/`)[1];
  if (!rawKey) return c.json({ error: 'missing key' }, 400);
  const key = decodeURIComponent(rawKey);
  if (!validUploadKey(key)) return c.json({ error: 'invalid key' }, 400);
  const contentLength = Number(c.req.header('content-length') ?? NaN);
  if (!Number.isFinite(contentLength)) return c.json({ error: 'content-length required' }, 411);
  if (contentLength > MAX_UPLOAD_BYTES) {
    return c.json({ error: `upload exceeds ${MAX_UPLOAD_BYTES} bytes` }, 413);
  }
  const contentType = c.req.header('content-type') ?? 'application/octet-stream';
  await bucket(c.env, b).put(key, c.req.raw.body, {
    httpMetadata: { contentType },
  });
  return c.json({ ok: true, key });
});
