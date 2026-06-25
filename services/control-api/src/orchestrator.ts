import type { JobStatus, QueueMessage, OfflineRenderSpec, JobEvent } from '@las/protocol';
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

interface AvatarRef {
  r2_prefix: string;
  tier: string;
}
interface VoiceRef {
  r2_prefix: string;
  engine: string;
}

async function runOfflineRender(env: Env, jobId: string, userId: string, spec: OfflineRenderSpec): Promise<void> {
  const provider = makeGpuProvider(env);

  const avatar = await env.DB.prepare('SELECT r2_prefix, tier FROM avatars WHERE id = ? AND user_id = ?')
    .bind(spec.avatarId, userId)
    .first<AvatarRef>();
  const voice = await env.DB.prepare('SELECT r2_prefix, engine FROM voices WHERE id = ? AND user_id = ?')
    .bind(spec.voiceId, userId)
    .first<VoiceRef>();
  if (!avatar || !voice) throw new Error('avatar or voice not found');

  const outPrefix = `work/${jobId}`;

  // 1) TTS with DSL prosody.
  await setStatus(env, jobId, 'tts', { progress: 0.1, message: 'Synthesizing voice' });
  const { audioKey } = await provider.call<{ audioKey: string }>(
    'voice',
    '/tts',
    {
      jobId,
      voicePrefix: voice.r2_prefix,
      engine: voice.engine,
      script: spec.script,
      outPrefix,
    },
    COLD_START_RETRY,
  );

  // 2) Talking-head synthesis -> finishing, both off the proxied request path.
  // A premium EchoMimicV3 render alone runs ~3min, past the RunPod proxy's ~100s
  // ceiling, so /render is fire-and-forget: it returns 202 immediately, renders
  // on a daemon thread, then chains directly into the finishing service over the
  // pod's localhost (unproxied). Finishing then drives the job to its terminal
  // state (succeeded with outputKey, or failed) over the progress webhook. We
  // hand it the outputKey + fps up front, set an intermediate status, and STOP —
  // the webhook owns the terminal transition, so there is no double-status race.
  const outputKey = `${jobId}.mp4`;
  await setStatus(env, jobId, 'talking_head', { progress: 0.4, message: 'Generating talking-head frames' });
  await provider.call(
    'avatar-video',
    '/render',
    {
      jobId,
      avatarPrefix: avatar.r2_prefix,
      audioKey,
      script: spec.script,
      tier: spec.tier,
      outPrefix,
      fps: spec.fps,
      outputKey,
    },
    COLD_START_RETRY,
  );
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
 * the proxy window. Errors are captured onto the avatar row and swallowed so the
 * message is acked — a failed build must not trigger a retry storm that re-runs
 * the GPU work.
 */
async function runAvatarBuild(env: Env, spec: AvatarBuildSpec): Promise<void> {
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
  } catch (e) {
    await env.DB.prepare('UPDATE avatars SET status = ? WHERE id = ?').bind('failed', spec.avatarId).run();
    console.error('avatar build failed', spec.avatarId, e);
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
 * clone. Like runAvatarBuild, state lives on the voices table (not the jobs
 * table) and errors are captured onto the row then swallowed so the message is
 * acked — a failed clone must not trigger a retry storm that re-runs GPU work.
 */
async function runVoiceClone(env: Env, spec: VoiceCloneSpec): Promise<void> {
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare('UPDATE voices SET status = ?, error = ? WHERE id = ?')
      .bind('failed', msg, spec.voiceId)
      .run();
    console.error('voice clone failed', spec.voiceId, msg);
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
        case 'offline_render':
          await setStatus(env, job.jobId, 'running', { progress: 0.02, message: 'Picked up' });
          await runOfflineRender(env, job.jobId, job.userId, job.spec as OfflineRenderSpec);
          break;
        case 'health_check':
          await setStatus(env, job.jobId, 'running', { progress: 0.02, message: 'Picked up' });
          await runHealthCheck(env, job.jobId);
          break;
        case 'avatar_build':
          // avatar_build tracks state on the avatars table, not the jobs table, and
          // never throws out of runAvatarBuild — so it always acks (no retry storm).
          await runAvatarBuild(env, job.spec as AvatarBuildSpec);
          break;
        case 'voice_clone':
          // voice_clone tracks state on the voices table, not the jobs table, and
          // never throws out of runVoiceClone — so it always acks (no retry storm).
          await runVoiceClone(env, job.spec as VoiceCloneSpec);
          break;
        default: {
          const _exhaustive: never = job.kind;
          throw new Error(`unhandled job kind ${_exhaustive as string}`);
        }
      }
      msg.ack();
    } catch (e) {
      // Only jobs-table-backed kinds reach here; avatar_build manages its own row.
      await setStatus(env, job.jobId, 'failed', { error: String(e) }).catch(() => undefined);
      msg.retry();
    }
  }
}
