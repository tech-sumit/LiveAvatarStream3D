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
  /**
   * Per-attempt timeout. An upstream that accepts the connection but never
   * responds (e.g. a wedged GPU pod) aborts after this instead of hanging the
   * queue consumer; the abort counts as a retryable network failure. Default
   * 120s — long enough for cold-start-slow GPU calls, bounded enough to fail.
   */
  timeoutMs?: number;
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
 * is returned as-is so callers still see client errors immediately. Each attempt
 * is bounded by `timeoutMs` (default 120s); a timed-out attempt is retried like
 * any other network failure. Callers must keep the request idempotent — a
 * retried POST may run twice if the first attempt's response was lost.
 * Defaults: 3 attempts, ~150–400ms jittered backoff.
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
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const last = i === attempts - 1;
    try {
      // A caller-supplied signal wins; otherwise bound the attempt so a hung
      // upstream can't stall the Worker/queue consumer indefinitely.
      const res = await fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      });
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
