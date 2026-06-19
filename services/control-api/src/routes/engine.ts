import { Hono } from 'hono';
import { ZodError } from 'zod';
import { CreateEngineRenderJobRequest, type QueueMessage } from '@las/protocol';
import type { Env } from '../env.js';
import { ensureUser, rowToJob } from '../lib/db.js';
import { newId, now } from '../lib/ids.js';

export const engine = new Hono<{ Bindings: Env }>();

/**
 * Create a 3D-engine cinematic render job and enqueue it. Mirrors POST
 * /api/jobs (offline_render) but routes to the Three.js + glTF avatar path via
 * the `engine_render` job kind. The orchestrator runs TTS, compiles a
 * PerformanceManifest, and dispatches it to the engine-three render node.
 */
engine.post('/api/engine-jobs', async (c) => {
  const raw = await c.req.json();
  const parsed = CreateEngineRenderJobRequest.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error instanceof ZodError ? parsed.error.flatten() : parsed.error;
    return c.json({ error: 'invalid engine job spec', detail }, 400);
  }
  const body = parsed.data;
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

/** Fetch the compiled performance manifest for an engine_render job (debug). */
engine.get('/api/engine-jobs/:id/manifest', async (c) => {
  const idParam = c.req.param('id');
  // Accept full id or a unique prefix (UI sometimes truncates for display).
  let row = await c.env.DB.prepare('SELECT id, status, kind, spec_json FROM jobs WHERE id = ?')
    .bind(idParam)
    .first<{ id: string; status: string; kind: string; spec_json: string }>();
  if (!row && idParam.length >= 8) {
    row = await c.env.DB.prepare(
      'SELECT id, status, kind, spec_json FROM jobs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1',
    )
      .bind(`${idParam}%`)
      .first<{ id: string; status: string; kind: string; spec_json: string }>();
  }
  if (!row) {
    return c.json(
      {
        error: 'job not found',
        hint: 'Use the full job id from the editor (e.g. job_mqlg5lsk99daf55780b7), not a truncated prefix.',
      },
      404,
    );
  }
  if (row.kind !== 'engine_render') {
    return c.json({ error: 'not an engine_render job', jobId: row.id, kind: row.kind }, 400);
  }

  const manifestKey = `work/${row.id}/manifest.json`;
  const obj = await c.env.OUTPUTS.get(manifestKey);
  if (!obj) {
    let specScene: unknown = null;
    try {
      const spec = JSON.parse(row.spec_json) as { scene?: unknown };
      if (spec.scene && typeof spec.scene === 'object') {
        const scene = spec.scene as {
          activeCameraId?: string;
          nodes?: { type?: string; id?: string; transform?: { rotation?: number[] } }[];
        };
        const cam = scene.nodes?.find(
          (n) => n.type === 'camera' && n.id === scene.activeCameraId,
        );
        specScene = {
          activeCameraId: scene.activeCameraId,
          cameraRotation: cam?.transform?.rotation ?? null,
        };
      }
    } catch {
      /* ignore malformed spec_json */
    }
    const hint =
      row.status === 'tts' || row.status === 'running'
        ? 'TTS in progress — manifest is written after voice synthesis finishes (usually 5–15s).'
        : row.status === 'compiling'
          ? 'Compiling manifest now — retry in a few seconds.'
          : row.status === 'failed'
            ? 'Job failed before manifest was written; check job events for the error.'
            : 'Manifest not in R2 yet; confirm status is rendering or succeeded.';
    return c.json(
      {
        error: 'manifest not ready',
        jobId: row.id,
        status: row.status,
        manifestKey,
        hint,
        specScene,
      },
      404,
    );
  }
  return new Response(obj.body, { headers: { 'content-type': 'application/json' } });
});
