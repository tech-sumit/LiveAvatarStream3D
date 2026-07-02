import { describe, it, expect } from 'vitest';
import type { QueueMessage } from '@las/protocol';
import { jobs, retryableJobError } from './jobs.js';
import type { Env } from '../env.js';

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/jobs/:id/retry — re-enqueues a FAILED job with its original spec,
// resets the jobs row to queued, and mirrors the reset onto the avatar/voice
// row the studio polls. In-memory D1 + queue fakes exercise the exact route via
// Hono's app.request(path, init, env) (same pattern as voices.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

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

/** Minimal D1 fake: interprets the route's SELECT/UPDATEs by keyword + bound args. */
function fakeDB(rows: JobRow[]) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const assetUpdates: Array<{ table: 'avatars' | 'voices'; id: string }> = [];
  return {
    db: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (/SELECT \* FROM jobs/i.test(sql)) return store.get(args[0] as string) ?? null;
                return null;
              },
              async run() {
                if (/UPDATE jobs SET status = 'queued'/i.test(sql)) {
                  const [updatedAt, id] = args as [number, string];
                  const row = store.get(id);
                  if (row) {
                    row.status = 'queued';
                    row.error = null;
                    row.updated_at = updatedAt;
                  }
                } else if (/UPDATE avatars/i.test(sql)) {
                  assetUpdates.push({ table: 'avatars', id: args[0] as string });
                } else if (/UPDATE voices/i.test(sql)) {
                  assetUpdates.push({ table: 'voices', id: args[0] as string });
                }
                return { success: true };
              },
            };
          },
        };
      },
    },
    row: (id: string) => store.get(id),
    assetUpdates,
  };
}

/** Queue fake recording every send. */
function fakeQueue() {
  const sent: QueueMessage[] = [];
  return { queue: { send: async (m: QueueMessage) => void sent.push(m) }, sent };
}

function makeEnv(db: ReturnType<typeof fakeDB>, q: ReturnType<typeof fakeQueue>): Env {
  return { DB: db.db, JOBS: q.queue } as unknown as Env;
}

const failedAvatarBuild: JobRow = {
  id: 'job_1',
  user_id: 'demo-user',
  kind: 'avatar_build',
  status: 'failed',
  spec_json: JSON.stringify({ avatarId: 'av_1', userId: 'demo-user', outPrefix: 'demo-user/av_1' }),
  output_key: null,
  error: 'gpu exploded',
  created_at: 1000,
  updated_at: 2000,
};

describe('retryableJobError', () => {
  it('allows only failed jobs', () => {
    expect(retryableJobError({ status: 'failed' })).toBeNull();
    for (const status of ['queued', 'running', 'succeeded'] as const) {
      expect(retryableJobError({ status })).toMatch(`job is ${status}`);
    }
  });
});

describe('POST /api/jobs/:id/retry', () => {
  it('re-enqueues a failed avatar build with its original spec and resets both rows', async () => {
    const db = fakeDB([failedAvatarBuild]);
    const q = fakeQueue();

    const res = await jobs.request('/api/jobs/job_1/retry', { method: 'POST' }, makeEnv(db, q));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { status: string; error?: string } };
    expect(body.job.status).toBe('queued');
    expect(body.job.error).toBeUndefined();
    expect(db.row('job_1')).toMatchObject({ status: 'queued', error: null });
    expect(db.assetUpdates).toEqual([{ table: 'avatars', id: 'av_1' }]); // studio row reset too
    expect(q.sent).toEqual([
      {
        jobId: 'job_1',
        kind: 'avatar_build',
        userId: 'demo-user',
        spec: { avatarId: 'av_1', userId: 'demo-user', outPrefix: 'demo-user/av_1' },
      },
    ]);
  });

  it('resets the voices row for a failed voice clone', async () => {
    const db = fakeDB([
      {
        ...failedAvatarBuild,
        id: 'job_2',
        kind: 'voice_clone',
        spec_json: JSON.stringify({ voiceId: 'vo_1', userId: 'demo-user' }),
      },
    ]);
    const q = fakeQueue();

    const res = await jobs.request('/api/jobs/job_2/retry', { method: 'POST' }, makeEnv(db, q));

    expect(res.status).toBe(200);
    expect(db.assetUpdates).toEqual([{ table: 'voices', id: 'vo_1' }]);
    expect(q.sent.map((m) => m.kind)).toEqual(['voice_clone']);
  });

  it('404s for an unknown job id without enqueueing', async () => {
    const db = fakeDB([]);
    const q = fakeQueue();

    const res = await jobs.request('/api/jobs/job_missing/retry', { method: 'POST' }, makeEnv(db, q));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'job not found' });
    expect(q.sent).toEqual([]);
  });

  it('400s for a non-failed job without touching rows or the queue', async () => {
    const db = fakeDB([{ ...failedAvatarBuild, status: 'running', error: null }]);
    const q = fakeQueue();

    const res = await jobs.request('/api/jobs/job_1/retry', { method: 'POST' }, makeEnv(db, q));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch('job is running');
    expect(db.row('job_1')).toMatchObject({ status: 'running' }); // untouched
    expect(db.assetUpdates).toEqual([]);
    expect(q.sent).toEqual([]);
  });
});
