import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env.js';
import { uploads } from './routes/uploads.js';
import { avatars } from './routes/avatars.js';
import { voices } from './routes/voices.js';
import { jobs } from './routes/jobs.js';
import { engine } from './routes/engine.js';
import { director } from './routes/director.js';
import { sessions } from './routes/sessions.js';
import { internal } from './routes/internal.js';
import { handleQueue } from './orchestrator.js';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/api/health', (c) => c.json({ ok: true, service: 'control-api' }));

app.route('/', uploads);
app.route('/', avatars);
app.route('/', voices);
app.route('/', jobs);
app.route('/', engine);
app.route('/', director);
app.route('/', sessions);
app.route('/', internal);

export default {
  fetch: app.fetch,
  // Cloudflare Queue consumer (offline job orchestration).
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
};

export { JobDO } from './do/JobDO.js';
export { SessionDO } from './do/SessionDO.js';
