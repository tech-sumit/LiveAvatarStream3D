import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './server.js';

const cfg = loadConfig();
const app = createApp(cfg);

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`engine-three listening on :${info.port}`);
});
