import { describe, it, expect } from 'vitest';
import { isStuckJob, sweepStuckJobs, STUCK_JOB_TIMEOUT_MS } from './orchestrator.js';
import type { Env } from './env.js';

// ─────────────────────────────────────────────────────────────────────────────
// Stuck-row sweeper — jobs (and avatar/voice rows) left non-terminal for > 2 h
// by a dead consumer get marked failed ('timed out'). In-memory D1/DO fakes in
// the voices.test.ts style: interpret each statement by keyword + bound args.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 10 * STUCK_JOB_TIMEOUT_MS; // any fixed "now" well past the timeout
const OLD = NOW - STUCK_JOB_TIMEOUT_MS - 1; // just past the threshold
const FRESH = NOW - 1000; // well within it

describe('isStuckJob', () => {
  it('flags non-terminal rows older than the timeout', () => {
    expect(isStuckJob({ status: 'queued', updated_at: OLD }, NOW)).toBe(true);
    expect(isStuckJob({ status: 'running', updated_at: OLD }, NOW)).toBe(true);
    expect(isStuckJob({ status: 'tts', updated_at: OLD }, NOW)).toBe(true); // any mid-stage status counts
  });

  it('never flags terminal rows, however old', () => {
    expect(isStuckJob({ status: 'succeeded', updated_at: 0 }, NOW)).toBe(false);
    expect(isStuckJob({ status: 'failed', updated_at: 0 }, NOW)).toBe(false);
  });

  it('leaves fresh and exactly-at-threshold rows alone', () => {
    expect(isStuckJob({ status: 'running', updated_at: FRESH }, NOW)).toBe(false);
    expect(isStuckJob({ status: 'running', updated_at: NOW - STUCK_JOB_TIMEOUT_MS }, NOW)).toBe(false);
  });
});

interface JobRow {
  id: string;
  status: string;
  updated_at: number;
  error?: string | null;
}

/**
 * Minimal env fake for sweepStuckJobs: D1 serving the non-terminal SELECT from
 * an in-memory map, applying setStatus's jobs UPDATE, and recording the
 * avatar/voice sweep cutoffs; a no-op JOB_DO for setStatus's event fan-out.
 */
function fakeEnv(rows: JobRow[]) {
  const jobRows = new Map(rows.map((r) => [r.id, { ...r }]));
  const cutoffs: Array<{ table: 'avatars' | 'voices'; cutoff: number }> = [];
  const events: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          // Unbound SELECT — the sweeper's non-terminal jobs scan.
          async all() {
            const results = [...jobRows.values()].filter(
              (r) => r.status !== 'succeeded' && r.status !== 'failed',
            );
            return { results };
          },
          bind(...args: unknown[]) {
            return {
              async run() {
                if (/UPDATE jobs/i.test(sql)) {
                  // setStatus binds (status, outputKey, status, error, updated_at, id).
                  const [status, , , error, updatedAt, id] = args as [
                    string,
                    unknown,
                    unknown,
                    string | null,
                    number,
                    string,
                  ];
                  const row = jobRows.get(id);
                  if (row) Object.assign(row, { status, error, updated_at: updatedAt });
                } else if (/INSERT INTO job_events/i.test(sql)) {
                  events.push(args[1] as string); // job_id
                } else if (/UPDATE avatars/i.test(sql)) {
                  cutoffs.push({ table: 'avatars', cutoff: args[0] as number });
                } else if (/UPDATE voices/i.test(sql)) {
                  cutoffs.push({ table: 'voices', cutoff: args[0] as number });
                }
                return { success: true };
              },
            };
          },
        };
      },
    },
    JOB_DO: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null) }),
    },
  } as unknown as Env;
  return { env, jobRows, cutoffs, events };
}

describe('sweepStuckJobs', () => {
  it('fails only the stuck rows and leaves fresh/terminal ones untouched', async () => {
    const { env, jobRows, cutoffs, events } = fakeEnv([
      { id: 'job_stuck_q', status: 'queued', updated_at: OLD },
      { id: 'job_stuck_r', status: 'running', updated_at: OLD },
      { id: 'job_fresh', status: 'running', updated_at: FRESH },
      { id: 'job_done', status: 'succeeded', updated_at: 0 },
    ]);

    const swept = await sweepStuckJobs(env, NOW);

    expect(swept).toBe(2);
    expect(jobRows.get('job_stuck_q')).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(jobRows.get('job_stuck_r')).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(jobRows.get('job_fresh')).toMatchObject({ status: 'running' });
    expect(jobRows.get('job_done')).toMatchObject({ status: 'succeeded' });
    expect(events.sort()).toEqual(['job_stuck_q', 'job_stuck_r']); // audit trail written
    // Companion asset sweeps run once each with the 2 h cutoff.
    expect(cutoffs).toEqual([
      { table: 'avatars', cutoff: NOW - STUCK_JOB_TIMEOUT_MS },
      { table: 'voices', cutoff: NOW - STUCK_JOB_TIMEOUT_MS },
    ]);
  });

  it('sweeps nothing when every job is fresh or terminal', async () => {
    const { env, jobRows } = fakeEnv([
      { id: 'job_fresh', status: 'queued', updated_at: FRESH },
      { id: 'job_failed', status: 'failed', updated_at: 0, error: 'boom' },
    ]);

    const swept = await sweepStuckJobs(env, NOW);

    expect(swept).toBe(0);
    expect(jobRows.get('job_fresh')).toMatchObject({ status: 'queued' });
    expect(jobRows.get('job_failed')).toMatchObject({ status: 'failed', error: 'boom' });
  });
});
