import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env.js';
import { apiBearerAuth } from './lib/auth.js';
import { uploads } from './routes/uploads.js';
import { avatars } from './routes/avatars.js';
import { voices } from './routes/voices.js';
import { jobs } from './routes/jobs.js';
import { director } from './routes/director.js';
import { internal } from './routes/internal.js';
import { handleQueue, sweepStuckJobs } from './orchestrator.js';

const app = new Hono<{ Bindings: Env }>();

// CORS first so preflights succeed and 401s still carry CORS headers. When the
// ALLOWED_ORIGINS var is set (comma-separated origins) only those origins get
// CORS; unset keeps the previous wide-open behavior (POC default).
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allowed = ((c.env as Env).ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowed.length === 0) return '*';
      return allowed.includes(origin) ? origin : null;
    },
  }),
);

// Optional bearer gate on the public API (no-op until the API_TOKEN secret is
// set; /api/health and /api/internal/* stay exempt — see lib/auth.ts).
app.use('/api/*', apiBearerAuth());

app.get('/api/health', (c) => c.json({ ok: true, service: 'control-api' }));

app.route('/', uploads);
app.route('/', avatars);
app.route('/', voices);
app.route('/', jobs);
app.route('/', director);
app.route('/', internal);

export default {
  fetch: app.fetch,
  // Cloudflare Queue consumer (offline job orchestration).
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
  // Cron (wrangler.toml [triggers]): fail rows stuck mid-flight > 2 h.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const swept = await sweepStuckJobs(env);
    if (swept > 0) console.warn(`sweepStuckJobs: marked ${swept} stuck job(s) as timed out`);
  },
};

export { JobDO } from './do/JobDO.js';
