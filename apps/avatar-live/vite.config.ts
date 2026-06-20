import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import { AwsClient } from 'aws4fetch';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Realtime avatar app. Port 5175 to avoid clashing with the scene editor (5174)
// and the web app.
//
// ElevenLabs: set ELEVENLABS_API_KEY in apps/avatar-live/.env (NOT prefixed with
// VITE_, so it stays server-side). The dev server proxies `/eleven/*` to the
// ElevenLabs API and injects the xi-api-key header — the key never reaches the
// browser and there is no CORS issue. (For production, front the API with an
// equivalent proxy / Worker.)
//
// Cloudflare R2 persistence: set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
// R2_SECRET_ACCESS_KEY / R2_ENDPOINT (+ optional R2_BUCKET) in .env. The dev
// server signs S3 requests (SigV4) server-side so the secret keys never reach
// the browser. The bucket is auto-created on first write. Routes:
//   GET    /r2/list?prefix=…   → { keys: [...] }
//   GET    /r2/o/<key>         → object bytes
//   PUT    /r2/o/<key>         → store object
//   DELETE /r2/o/<key>         → delete object
//
// Optional A2F: VITE_A2F_URL points at an Audio2Face-3D HTTP wrapper.

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function r2Plugin(env: Record<string, string>): Plugin {
  const endpoint = (env.R2_ENDPOINT || '').replace(/\/$/, '');
  const bucket = env.R2_BUCKET || 'las-avatar-live';
  const configured = !!(endpoint && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
  const aws = configured
    ? new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        region: 'auto',
        service: 's3',
      })
    : null;
  let bucketReady = false;

  async function ensureBucket(): Promise<void> {
    if (bucketReady || !aws) return;
    // HEAD the bucket; create it if it doesn't exist.
    const head = await aws.fetch(`${endpoint}/${bucket}`, { method: 'HEAD' });
    if (head.status === 404 || head.status === 403) {
      await aws.fetch(`${endpoint}/${bucket}`, { method: 'PUT' });
    }
    bucketReady = true;
  }

  return {
    name: 'r2-proxy',
    configureServer(server) {
      const handler: Connect.NextHandleFunction = async (req, res, next) => {
        const url = req.url || '';
        if (!url.startsWith('/r2/')) return next();
        if (!aws) {
          res.statusCode = 503;
          res.end('R2 not configured — set R2_* in apps/avatar-live/.env');
          return;
        }
        try {
          await ensureBucket();
          // GET /r2/list?prefix=  (follows pagination so >1000 keys are returned)
          if (url.startsWith('/r2/list')) {
            const prefix = new URL(url, 'http://x').searchParams.get('prefix') || '';
            const keys: string[] = [];
            let token: string | undefined;
            do {
              const q =
                `${endpoint}/${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}` +
                (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
              const xml = await (await aws.fetch(q)).text();
              for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1]));
              const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
              const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
              token = truncated && next ? decodeXml(next[1]) : undefined;
            } while (token);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ keys }));
            return;
          }
          // /r2/o/<key>
          const m = url.match(/^\/r2\/o\/([^?]+)/);
          if (!m) {
            res.statusCode = 400;
            res.end('bad r2 path');
            return;
          }
          const key = decodeURIComponent(m[1]);
          const target = `${endpoint}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

          if (req.method === 'GET') {
            // Forward Range so <video> can seek/stream large objects (206 partials).
            const range = req.headers['range'];
            const r = await aws.fetch(target, range ? { headers: { range } } : undefined);
            res.statusCode = r.status;
            res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
            res.setHeader('accept-ranges', 'bytes');
            for (const h of ['content-range', 'content-length']) {
              const v = r.headers.get(h);
              if (v) res.setHeader(h, v);
            }
            res.end(Buffer.from(await r.arrayBuffer()));
            return;
          }
          if (req.method === 'PUT') {
            const body = await readBody(req);
            const r = await aws.fetch(target, {
              method: 'PUT',
              body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit,
              headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' },
            });
            res.statusCode = r.ok ? 200 : r.status;
            res.end(r.ok ? 'ok' : await r.text());
            return;
          }
          if (req.method === 'DELETE') {
            const r = await aws.fetch(target, { method: 'DELETE' });
            res.statusCode = r.status;
            res.end('ok');
            return;
          }
          res.statusCode = 405;
          res.end('method not allowed');
        } catch (err) {
          res.statusCode = 500;
          res.end(`r2 error: ${String(err)}`);
        }
      };
      server.middlewares.use(handler as (req: IncomingMessage, res: ServerResponse, next: () => void) => void);
    },
  };
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const elevenKey = env.ELEVENLABS_API_KEY;
  return {
    plugins: [r2Plugin(env)],
    server: {
      port: 5175,
      host: true,
      proxy: elevenKey
        ? {
            '/eleven': {
              target: 'https://api.elevenlabs.io',
              changeOrigin: true,
              rewrite: (p) => p.replace(/^\/eleven/, '/v1'),
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyReq) => {
                  proxyReq.setHeader('xi-api-key', elevenKey);
                });
              },
            },
          }
        : undefined,
    },
    build: { target: 'es2022' },
  };
});
