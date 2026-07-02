import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';

/**
 * Optional bearer-token gate for the public /api/* surface.
 *
 * Env-gated: when the `API_TOKEN` Worker secret is set, every /api/* request
 * must carry `Authorization: Bearer <API_TOKEN>`. Exempt: the health route and
 * /api/internal/* (the GPU progress webhook already checks the shared
 * INTERNAL_SERVICE_TOKEN in routes/internal.ts — don't double-guard it). When
 * the secret is unset, behavior is unchanged (open API, POC default) but we
 * warn once per isolate so the open posture is never silent.
 */

/** Routes that stay open: health checks + internal routes with their own auth. */
function isExempt(path: string): boolean {
  return path === '/api/health' || path.startsWith('/api/internal/');
}

/**
 * Constant-time string equality. Compares SHA-256 digests so neither the
 * content nor the length of the expected token leaks through timing.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}

let warnedOpen = false;

export function apiBearerAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const token = c.env.API_TOKEN;
    if (!token) {
      if (!warnedOpen) {
        warnedOpen = true;
        console.warn(
          'control-api: API_TOKEN secret is not set — /api/* is unauthenticated. ' +
            'Set it (`wrangler secret put API_TOKEN`) before exposing this Worker publicly.',
        );
      }
      return next();
    }
    if (isExempt(c.req.path)) return next();
    const header = c.req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!presented || !(await timingSafeEqual(presented, token))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };
}
