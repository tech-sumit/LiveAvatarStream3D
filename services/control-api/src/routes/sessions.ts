import { Hono, type Context } from 'hono';
import { StartSessionRequest, TurnSource, MAX_TURN_TEXT_CHARS } from '@las/protocol';
import type { Env } from '../env.js';
import { ensureUser } from '../lib/db.js';
import { newId, now } from '../lib/ids.js';

export const sessions = new Hono<{ Bindings: Env }>();

/** Start a realtime session: allocate a GPU node + return SFU media info
 *  (sessionId, Realtime app id, ICE servers). */
sessions.post('/api/sessions', async (c) => {
  const body = StartSessionRequest.parse(await c.req.json());
  await ensureUser(c.env, body.userId);

  // One DO per session.
  const sessionName = newId('sess');
  const stub = c.env.SESSION_DO.get(c.env.SESSION_DO.idFromName(sessionName));
  const res = await stub.fetch('https://do/start', { method: 'POST', body: JSON.stringify(body) });
  // The DO surfaces an unavailable/non-warm GPU node as a non-2xx (503). Don't
  // parse that as media or persist a half-started session — fail fast with a
  // clean retryable error instead of a raw 500.
  if (!res.ok) {
    c.header('Retry-After', '5');
    return c.json({ error: 'avatar node is warming or unavailable, please retry' }, 503);
  }
  const media = (await res.json()) as { sessionId: string };

  await c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, avatar_id, voice_id, status, persona, started_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(media.sessionId, body.userId, body.avatarId, body.voiceId, 'live', body.persona, now())
    .run();

  // Map the public sessionId to its DO name for later control/turn routing.
  await c.env.CACHE.put(`sess:${media.sessionId}`, sessionName, { expirationTtl: 60 * 60 * 6 });
  return c.json(media);
});

async function stubFor(c: { env: Env }, sessionId: string) {
  const name = await c.env.CACHE.get(`sess:${sessionId}`);
  if (!name) return null;
  return c.env.SESSION_DO.get(c.env.SESSION_DO.idFromName(name));
}

/** Browser control channel (barge-in / mute / end). */
sessions.get('/api/sessions/:id/control', async (c) => {
  const stub = await stubFor(c, c.req.param('id'));
  if (!stub) return c.json({ error: 'not found' }, 404);
  return stub.fetch('https://do/control', { headers: c.req.raw.headers });
});

/**
 * Finalized user turn. Spoken turns (`source` omitted / 'voice') come from the
 * GPU worker and require the internal token. Typed turns ('text') come from the
 * browser, which is authorized by possession of the unguessable sessionId — the
 * same capability model as the `/rt` browser routes.
 */
sessions.post('/api/sessions/:id/turn', async (c) => {
  const raw = await c.req.text();
  let body: { text?: unknown; source?: unknown } = {};
  try {
    body = JSON.parse(raw) as { text?: unknown; source?: unknown };
  } catch {
    // Malformed body: `source` stays unset → treated as 'voice' → token-gated.
  }

  // Validate `source` against the enum: an absent source is the GPU/STT contract
  // ('voice'); an explicit but unknown value is rejected rather than silently
  // defaulted, so a malformed client can't slip past the token gate.
  let source: TurnSource = 'voice';
  if (body.source !== undefined) {
    const parsed = TurnSource.safeParse(body.source);
    if (!parsed.success) return c.json({ error: 'invalid source' }, 400);
    source = parsed.data;
  }

  // Typed turns are authorized by the unguessable sessionId; the voice/STT path
  // (source omitted or 'voice') still requires the internal token — unchanged.
  if (source !== 'text' && c.req.header('x-internal-token') !== c.env.INTERNAL_SERVICE_TOKEN) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Reject empty/whitespace and oversized text at the edge, before spending a DO
  // hop or an LLM/GPU turn on the token-less browser path.
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.trim().length === 0) return c.json({ error: 'empty text' }, 400);
  if (text.length > MAX_TURN_TEXT_CHARS) return c.json({ error: 'text too long' }, 400);

  const stub = await stubFor(c, c.req.param('id'));
  if (!stub) return c.json({ error: 'not found' }, 404);
  return stub.fetch('https://do/turn', { method: 'POST', body: raw });
});

/**
 * Realtime SFU control plane proxied to the session DO.
 *
 * Auth: `peer === 'gpu'` is an internal call and requires the internal service
 * token; `peer === 'browser'` is open because possession of the (unguessable)
 * sessionId is the capability. The DO's 425 ("publisher not live yet") is
 * forwarded through unchanged so clients can retry.
 */
async function rtProxy(c: Context<{ Bindings: Env }>, doPath: string): Promise<Response> {
  const body = (await c.req.json()) as { peer?: string };
  if (body.peer === 'gpu' && c.req.header('x-internal-token') !== c.env.INTERNAL_SERVICE_TOKEN) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  const name = await c.env.CACHE.get(`sess:${c.req.param('id')}`);
  if (!name) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  const stub = c.env.SESSION_DO.get(c.env.SESSION_DO.idFromName(name));
  return stub.fetch(`https://do${doPath}`, { method: 'POST', body: JSON.stringify(body) });
}

sessions.post('/api/sessions/:id/rt/publish', (c) => rtProxy(c, '/rt/publish'));
sessions.post('/api/sessions/:id/rt/subscribe', (c) => rtProxy(c, '/rt/subscribe'));
sessions.post('/api/sessions/:id/rt/renegotiate', (c) => rtProxy(c, '/rt/renegotiate'));

sessions.delete('/api/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const stub = await stubFor(c, id);
  if (stub) await stub.fetch('https://do/end', { method: 'POST' });
  await c.env.DB.prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?')
    .bind('ended', now(), id)
    .run();
  return c.json({ ok: true });
});
