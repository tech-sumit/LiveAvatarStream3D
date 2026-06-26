import { describe, it, expect } from 'vitest';
import { voices } from './voices.js';
import type { Env } from '../env.js';

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/voices/:id — removes the D1 row AND purges the cloned voice's R2
// assets under r2_prefix (paginated list→delete), so a delete never orphans
// storage. Faithful in-memory D1 + R2 fakes exercise the exact route via Hono's
// app.request(path, init, env).
// ─────────────────────────────────────────────────────────────────────────────

interface VoiceRow {
  id: string;
  user_id: string;
  r2_prefix: string | null;
}

/** Minimal D1 fake: interprets the route's SELECT/DELETE by keyword + bound args. */
function fakeDB(rows: VoiceRow[]) {
  const store = new Map(rows.map((r) => [`${r.id}:${r.user_id}`, r]));
  return {
    db: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            const [id, userId] = args as [string, string];
            return {
              async first() {
                if (!/SELECT/i.test(sql)) return null;
                return store.get(`${id}:${userId}`) ?? null;
              },
              async run() {
                if (/DELETE/i.test(sql)) store.delete(`${id}:${userId}`);
                return { success: true };
              },
            };
          },
        };
      },
    },
    has: (id: string, userId: string) => store.has(`${id}:${userId}`),
  };
}

/** Minimal R2 fake: list (single page) + multi-key delete, recording purges. */
function fakeBucket(keys: string[]) {
  const store = new Set(keys);
  const deleted: string[] = [];
  return {
    bucket: {
      async list({ prefix }: { prefix?: string; cursor?: string }) {
        const objects = [...store].filter((k) => !prefix || k.startsWith(prefix)).map((key) => ({ key }));
        return { objects, truncated: false as const, delimitedPrefixes: [] };
      },
      async delete(ks: string | string[]) {
        for (const k of Array.isArray(ks) ? ks : [ks]) {
          store.delete(k);
          deleted.push(k);
        }
      },
    },
    deleted,
    remaining: () => [...store],
  };
}

function makeEnv(db: ReturnType<typeof fakeDB>, voicesBucket: ReturnType<typeof fakeBucket>): Env {
  return { DB: db.db, VOICES: voicesBucket.bucket } as unknown as Env;
}

describe('DELETE /api/voices/:id', () => {
  it('purges the row and its R2 objects, returning the purge count', async () => {
    const db = fakeDB([{ id: 'vo_1', user_id: 'demo-user', r2_prefix: 'demo-user/vo_1' }]);
    const r2 = fakeBucket([
      'demo-user/vo_1/sample.wav',
      'demo-user/vo_1/model.bin',
      'demo-user/vo_2/other.wav', // a different voice — must be left intact
    ]);

    const res = await voices.request('/api/voices/vo_1?userId=demo-user', { method: 'DELETE' }, makeEnv(db, r2));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 'vo_1', deletedObjects: 2 });
    expect(db.has('vo_1', 'demo-user')).toBe(false); // row gone
    expect(r2.deleted.sort()).toEqual(['demo-user/vo_1/model.bin', 'demo-user/vo_1/sample.wav']);
    expect(r2.remaining()).toEqual(['demo-user/vo_2/other.wav']); // other voice untouched
  });

  it('404s and touches no R2 when the voice does not exist for the user', async () => {
    const db = fakeDB([{ id: 'vo_1', user_id: 'someone-else', r2_prefix: 'someone-else/vo_1' }]);
    const r2 = fakeBucket(['someone-else/vo_1/sample.wav']);

    const res = await voices.request('/api/voices/vo_1?userId=demo-user', { method: 'DELETE' }, makeEnv(db, r2));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'voice not found' });
    expect(r2.deleted).toEqual([]); // no purge attempted
    expect(db.has('vo_1', 'someone-else')).toBe(true); // other user's row intact
  });

  it('still deletes the row when the voice has no r2_prefix', async () => {
    const db = fakeDB([{ id: 'vo_3', user_id: 'demo-user', r2_prefix: null }]);
    const r2 = fakeBucket(['demo-user/vo_3/stray.wav']);

    const res = await voices.request('/api/voices/vo_3?userId=demo-user', { method: 'DELETE' }, makeEnv(db, r2));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 'vo_3', deletedObjects: 0 });
    expect(db.has('vo_3', 'demo-user')).toBe(false);
    expect(r2.deleted).toEqual([]); // no prefix → no R2 work
  });
});
