import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from './config.js';
import { type RenderJobBody, runRenderJob } from './renderJob.js';

export function createApp(cfg: Config): Hono {
  const app = new Hono();
  const leeGlb = join(cfg.assetsDir, 'avatars', 'LeePerrySmith', 'LeePerrySmith.glb');

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'engine-three',
      backend: cfg.renderBackend,
      lipsyncMode: cfg.lipsyncMode,
      montageMode: cfg.montageMode,
      renderProfile: cfg.renderProfile,
      avatarLoaded: existsSync(join(cfg.assetsDir, 'avatars', 'ada.glb')),
      leePerrySmithLoaded: existsSync(leeGlb),
      wysiwygScene: true,
    }),
  );

  app.post('/render', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const internal = c.req.header('x-internal-token') ?? '';
    if (
      cfg.internalToken &&
      token !== cfg.internalToken &&
      internal !== cfg.internalToken
    ) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const body = (await c.req.json()) as RenderJobBody;
    if (!body.jobId || !body.manifestKey || !body.outputKey) {
      return c.json({ error: 'jobId, manifestKey, outputKey required' }, 400);
    }

    void runRenderJob(cfg, body);
    return c.json({ accepted: true, jobId: body.jobId, outputKey: body.outputKey }, 202);
  });

  return app;
}
