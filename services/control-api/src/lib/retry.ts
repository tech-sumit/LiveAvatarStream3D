export interface RetryOpts {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Also retry on HTTP 404. Off by default so genuine client 404s fail fast.
   * GPU provider calls opt in: the RunPod proxy returns a transient 404 (not a
   * 5xx) while the upstream uvicorn is still warming/binding, even though every
   * GPU service route is known-good — so for those calls a 404 is a transient
   * proxy state, not a real "route missing".
   */
  retry404?: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number, base: number, max: number): number {
  const exp = Math.min(base * 2 ** attempt, max);
  return exp / 2 + Math.random() * (exp / 2);
}

/**
 * fetch() with bounded retry-with-backoff for transient upstream failures.
 * Retries on network errors and 5xx responses (and, when `retry404` is set, on
 * 404 — for upstreams like the RunPod proxy that 404 during warm-up); other 4xx
 * is returned as-is so callers still see client errors immediately. Callers must
 * keep the request idempotent — a retried POST may run twice if the first
 * attempt's response was lost. Defaults: 3 attempts, ~150–400ms jittered backoff.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: RetryOpts = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 150;
  const max = opts.maxDelayMs ?? 400;
  const retry404 = opts.retry404 ?? false;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const last = i === attempts - 1;
    try {
      const res = await fetch(input, init);
      const transient = res.status >= 500 || (retry404 && res.status === 404);
      if (transient && !last) {
        await sleep(backoff(i, base, max));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (last) throw err;
      await sleep(backoff(i, base, max));
    }
  }
  throw lastErr;
}
