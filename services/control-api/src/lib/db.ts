import type { Env } from '../env.js';
import type { AvatarProfile, VoiceProfile, Job, JobEvent } from '@las/protocol';

/** Mapping helpers between D1 rows (snake_case) and protocol types (camelCase). */

interface AvatarRow {
  id: string;
  user_id: string;
  label: string;
  source_type: string;
  status: string;
  tier: string;
  r2_prefix: string;
  identity_dim: number | null;
  has_lora: number;
  ref_duration_s: number | null;
  created_at: number;
}

export function rowToAvatar(r: AvatarRow): AvatarProfile {
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    sourceType: r.source_type as AvatarProfile['sourceType'],
    status: r.status as AvatarProfile['status'],
    tier: r.tier as AvatarProfile['tier'],
    r2Prefix: r.r2_prefix,
    identityDim: r.identity_dim ?? undefined,
    hasLora: !!r.has_lora,
    refDurationS: r.ref_duration_s ?? undefined,
    createdAt: r.created_at,
  };
}

interface VoiceRow {
  id: string;
  user_id: string;
  label: string;
  status: string;
  engine: string;
  r2_prefix: string;
  language: string;
  created_at: number;
  sample_key: string | null;
  error: string | null;
}

export function rowToVoice(r: VoiceRow): VoiceProfile {
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    status: r.status as VoiceProfile['status'],
    engine: r.engine as VoiceProfile['engine'],
    r2Prefix: r.r2_prefix,
    language: r.language,
    createdAt: r.created_at,
    error: r.error ?? undefined,
  };
}

interface JobRow {
  id: string;
  user_id: string;
  kind: string;
  status: string;
  spec_json: string;
  output_key: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind as Job['kind'],
    status: r.status as Job['status'],
    spec: JSON.parse(r.spec_json),
    outputKey: r.output_key ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface JobEventRow {
  id: string;
  job_id: string;
  kind: string;
  status: string | null;
  progress: number | null;
  message: string | null;
  data_json: string | null;
  at: number;
}

export function rowToJobEvent(r: JobEventRow): JobEvent {
  return {
    id: r.id,
    jobId: r.job_id,
    kind: r.kind as JobEvent['kind'],
    status: (r.status as JobEvent['status']) ?? undefined,
    progress: r.progress ?? undefined,
    message: r.message ?? undefined,
    data: r.data_json ? JSON.parse(r.data_json) : undefined,
    at: r.at,
  };
}

/** Ensure a user row exists (no auth; auto-provision the demo namespace). */
export async function ensureUser(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO users (id, label, created_at) VALUES (?, ?, ?)',
  )
    .bind(userId, userId, Date.now())
    .run();
}
