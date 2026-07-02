import type { JobStatus, QueueMessage, JobEvent } from '@las/protocol';
import type { Env } from './env.js';
import { makeGpuProvider } from './gpu/provider.js';
import { fetchWithRetry, type RetryOpts } from './lib/retry.js';
import { newId, now } from './lib/ids.js';

/**
 * Cold-start retry policy for the first pod call after a launch/resume, when the
 * GPU service's uvicorn may not be warm yet. For GPU provider calls the transient
 * classes are network errors (connection refused / gateway not ready), 5xx (incl.
 * 502/503/504), and the RunPod proxy's warm-up 404 (provider.call sets retry404);
 * other 4xx (genuine bad input) fails fast without burning the full window.
 * 8 attempts with exponential 2s→60s jittered backoff span ~1.5–3 min of
 * retrying, comfortably covering the ~2 min observed pod warm-up.
 */
const COLD_START_RETRY: RetryOpts = { attempts: 8, baseDelayMs: 2000, maxDelayMs: 60000 };

/** Persist a status change to D1 and push an event to the job's DO. */
async function setStatus(
  env: Env,
  jobId: string,
  status: JobStatus,
  opts: { progress?: number; message?: string; outputKey?: string; error?: string } = {},
): Promise<void> {
  // On terminal success, wipe any stale error left by a failed-then-retried
  // attempt; otherwise keep/set it via COALESCE.
  await env.DB.prepare(
    "UPDATE jobs SET status = ?, output_key = COALESCE(?, output_key), error = CASE WHEN ? = 'succeeded' THEN NULL ELSE COALESCE(?, error) END, updated_at = ? WHERE id = ?",
  )
    .bind(status, opts.outputKey ?? null, status, opts.error ?? null, now(), jobId)
    .run();

  const event: JobEvent = {
    id: newId('evt'),
    jobId,
    kind: opts.error ? 'error' : opts.outputKey ? 'result' : 'status_changed',
    status,
    progress: opts.progress,
    message: opts.message,
    data: opts.outputKey ? { outputKey: opts.outputKey } : undefined,
    at: now(),
  };
  await env.DB.prepare(
    'INSERT INTO job_events (id, job_id, kind, status, progress, message, data_json, at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(
      event.id,
      jobId,
      event.kind,
      status,
      opts.progress ?? null,
      opts.message ?? null,
      event.data ? JSON.stringify(event.data) : null,
      event.at,
    )
    .run();

  const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
  await stub.fetch('https://do/append', { method: 'POST', body: JSON.stringify(event) }).catch(() => undefined);
}

interface AvatarBuildSpec {
  avatarId: string;
  userId: string;
  sourceType: string;
  sourceKey: string;
  prompt?: string;
  tier: string;
  fineTune: boolean;
  outPrefix: string;
}

/**
 * Build an avatar on the GPU plane and flip its D1 row building -> ready/failed.
 * Runs in the queue consumer (not a request waitUntil) so it survives the full
 * build; with buffalo_l preseeded on the volume the build comfortably fits inside
 * the proxy window. Errors are captured onto the avatar row and returned (never
 * thrown) so the message is acked — a failed build must not trigger a retry
 * storm that re-runs the GPU work. Returns the error message, or null on success.
 */
async function runAvatarBuild(env: Env, spec: AvatarBuildSpec): Promise<string | null> {
  const provider = makeGpuProvider(env);
  try {
    const res = await provider.call<{ identityDim?: number; hasLora?: boolean; refDurationS?: number }>(
      'avatar-build',
      '/build',
      {
        avatarId: spec.avatarId,
        userId: spec.userId,
        sourceType: spec.sourceType,
        sourceKey: spec.sourceKey,
        prompt: spec.prompt,
        tier: spec.tier,
        fineTune: spec.fineTune,
        outPrefix: spec.outPrefix,
      },
      COLD_START_RETRY,
    );
    await env.DB.prepare('UPDATE avatars SET status = ?, identity_dim = ?, has_lora = ?, ref_duration_s = ? WHERE id = ?')
      .bind('ready', res.identityDim ?? null, res.hasLora ? 1 : 0, res.refDurationS ?? null, spec.avatarId)
      .run();
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare('UPDATE avatars SET status = ? WHERE id = ?').bind('failed', spec.avatarId).run();
    console.error('avatar build failed', spec.avatarId, msg);
    return msg;
  }
}

interface VoiceCloneSpec {
  voiceId: string;
  userId: string;
  sampleKey: string;
  engine: string;
  language: string;
  outPrefix: string;
}

/**
 * Clone a voice on the GPU plane and flip its D1 row cloning -> ready/failed.
 * Runs in the queue consumer (not a request waitUntil) so it survives the full
 * clone. Like runAvatarBuild, errors are captured onto the voices row then
 * returned (never thrown) so the message is acked — a failed clone must not
 * trigger a retry storm that re-runs GPU work. Returns the error message, or
 * null on success.
 */
async function runVoiceClone(env: Env, spec: VoiceCloneSpec): Promise<string | null> {
  const provider = makeGpuProvider(env);
  try {
    await provider.call(
      'voice',
      '/clone',
      {
        voiceId: spec.voiceId,
        userId: spec.userId,
        sampleKey: spec.sampleKey,
        engine: spec.engine,
        language: spec.language,
        outPrefix: spec.outPrefix,
      },
      COLD_START_RETRY,
    );
    await env.DB.prepare('UPDATE voices SET status = ?, error = NULL WHERE id = ?')
      .bind('ready', spec.voiceId)
      .run();
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare('UPDATE voices SET status = ?, error = ? WHERE id = ?')
      .bind('failed', msg, spec.voiceId)
      .run();
    console.error('voice clone failed', spec.voiceId, msg);
    return msg;
  }
}

async function runHealthCheck(env: Env, jobId: string): Promise<void> {
  const provider = makeGpuProvider(env);
  const ok = await provider.health();
  if (!ok) throw new Error('gpu health-check failed');
  // Round-trip proof: write a small marker to OUTPUTS.
  const key = `health/${jobId}.txt`;
  await env.OUTPUTS.put(key, `ok ${new Date().toISOString()}`);
  await setStatus(env, jobId, 'succeeded', { progress: 1, message: 'health ok', outputKey: key });
}

/** Cloudflare Queue consumer entrypoint. */
export async function handleQueue(batch: MessageBatch, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const job = msg.body as QueueMessage;
    try {
      switch (job.kind) {
        case 'health_check':
          await setStatus(env, job.jobId, 'running', { progress: 0.02, message: 'Picked up' });
          await runHealthCheck(env, job.jobId);
          break;
        case 'avatar_build': {
          // The avatars row mirrors state for the studio UI; the jobs row is the
          // durable operator record. runAvatarBuild never throws, and the terminal
          // write below must not throw into the retry path either — the GPU work
          // is done and must not re-run; a lost write is repaired by the sweeper.
          await setStatus(env, job.jobId, 'running', { progress: 0.02, message: 'Picked up' });
          const err = await runAvatarBuild(env, job.spec as AvatarBuildSpec);
          await setStatus(
            env,
            job.jobId,
            err ? 'failed' : 'succeeded',
            err ? { error: err } : { progress: 1, message: 'Avatar ready' },
          ).catch(() => undefined);
          break;
        }
        case 'voice_clone': {
          // Same shape as avatar_build: voices row for the UI, jobs row for the
          // operator; runVoiceClone never throws, terminal write never retries.
          await setStatus(env, job.jobId, 'running', { progress: 0.02, message: 'Picked up' });
          const err = await runVoiceClone(env, job.spec as VoiceCloneSpec);
          await setStatus(
            env,
            job.jobId,
            err ? 'failed' : 'succeeded',
            err ? { error: err } : { progress: 1, message: 'Voice ready' },
          ).catch(() => undefined);
          break;
        }
        default: {
          const _exhaustive: never = job.kind;
          throw new Error(`unhandled job kind ${_exhaustive as string}`);
        }
      }
      msg.ack();
    } catch (e) {
      // Only health_check can throw to here; the GPU kinds capture their own errors.
      await setStatus(env, job.jobId, 'failed', { error: String(e) }).catch(() => undefined);
      msg.retry();
    }
  }
}

/** Jobs sitting in a non-terminal status longer than this are considered dead. */
export const STUCK_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed']);

/** True when a job row has sat in a non-terminal status past the stuck timeout. */
export function isStuckJob(row: { status: string; updated_at: number }, nowMs: number): boolean {
  return !TERMINAL_STATUSES.has(row.status) && nowMs - row.updated_at > STUCK_JOB_TIMEOUT_MS;
}

/**
 * Cron sweeper (wrangler.toml [triggers]): fail job rows — and the avatar/voice
 * rows the studio polls — that died mid-flight (e.g. a Worker eviction between
 * queue pickup and the terminal status write), so nothing shows queued/running
 * forever. Returns the number of job rows swept.
 */
export async function sweepStuckJobs(env: Env, nowMs = now()): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, status, updated_at FROM jobs WHERE status NOT IN ('succeeded','failed')",
  ).all<{ id: string; status: string; updated_at: number }>();
  const stuck = results.filter((r) => isStuckJob(r, nowMs));
  for (const row of stuck) {
    await setStatus(env, row.id, 'failed', { error: 'timed out' });
  }

  // Asset rows carry no updated_at; created_at is a safe proxy at a 2 h horizon
  // (builds/clones finish in minutes).
  const cutoff = nowMs - STUCK_JOB_TIMEOUT_MS;
  await env.DB.prepare(
    "UPDATE avatars SET status = 'failed' WHERE status IN ('pending','building','fine_tuning') AND created_at < ?",
  )
    .bind(cutoff)
    .run();
  await env.DB.prepare(
    "UPDATE voices SET status = 'failed', error = 'timed out' WHERE status IN ('pending','cloning') AND created_at < ?",
  )
    .bind(cutoff)
    .run();
  return stuck.length;
}
