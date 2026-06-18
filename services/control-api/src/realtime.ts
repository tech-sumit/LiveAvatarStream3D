import type { Env } from './env.js';
import { fetchWithRetry } from './lib/retry.js';

/**
 * Cloudflare Realtime (SFU + TURN) integration.
 *
 * Media is routed by the Cloudflare Realtime SFU and driven directly via its
 * sessions/tracks HTTPS API (Bearer = SFU app secret). The GPU worker publishes
 * the avatar's audio+video; the browser publishes mic audio and subscribes to
 * the avatar. This module mints short-lived TURN credentials and wraps the SFU
 * session/track lifecycle.
 */

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

const SFU_BASE = 'https://rtc.live.cloudflare.com/v1';

// Per-request ceiling for the teardown close path (GET session + force-close
// tracks). Without this an unresponsive SFU could hang `closeSession`
// unboundedly and stall session teardown.
const CLOSE_FETCH_TIMEOUT_MS = 4000;

/**
 * Generate ephemeral TURN credentials (valid for `ttlSeconds`).
 *
 * The TURN key is a distinct Cloudflare resource from the SFU app: it has its
 * own id (`CF_TURN_KEY_ID`) and long-term API token (`CF_TURN_KEY_API_TOKEN`)
 * used only here to mint short-lived ICE creds. If either is unset (local dev),
 * fall back to STUN only.
 */
export async function mintTurnCredentials(env: Env, ttlSeconds = 3600): Promise<IceServer[]> {
  if (!env.CF_TURN_KEY_ID || !env.CF_TURN_KEY_API_TOKEN) {
    return [{ urls: ['stun:stun.cloudflare.com:3478'] }];
  }
  try {
    const res = await fetchWithRetry(
      `${SFU_BASE}/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.CF_TURN_KEY_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl: ttlSeconds }),
      },
    );
    if (!res.ok) throw new Error(`turn mint failed: ${res.status}`);
    const data = (await res.json()) as {
      iceServers: { urls: string | string[]; username?: string; credential?: string }[];
    };
    return data.iceServers.map((ice) => ({
      urls: Array.isArray(ice.urls) ? ice.urls : [ice.urls],
      username: ice.username,
      credential: ice.credential,
    }));
  } catch {
    return [{ urls: ['stun:stun.cloudflare.com:3478'] }];
  }
}

// --- Cloudflare Realtime SFU sessions/tracks client ---------------------------

export type TrackKind = 'audio' | 'video';

/** A local track to publish: `mid`/`trackName`/`kind` from the local offer. */
export interface LocalTrack {
  mid: string;
  trackName: string;
  kind: TrackKind;
}

/** A reference to a remote track being subscribed to, by publisher session. */
export interface RemoteTrackRef {
  sessionId: string;
  trackName: string;
}

interface CfTrack {
  trackName: string;
  mid?: string;
}

interface CfTracksResponse {
  tracks?: CfTrack[];
  sessionDescription?: { type: string; sdp: string };
  requiresImmediateRenegotiation?: boolean;
}

function appBase(env: Env): string {
  return `${SFU_BASE}/apps/${env.CF_REALTIME_APP_ID}`;
}

async function cfFetch(
  env: Env,
  path: string,
  init: RequestInit,
  retry = false,
): Promise<Response> {
  const doFetch = retry ? fetchWithRetry : fetch;
  const res = await doFetch(`${appBase(env)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CF_REALTIME_APP_SECRET}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`cf sfu ${path} failed: ${res.status} ${detail}`);
  }
  return res;
}

/** Create a fresh SFU session. Returns the Cloudflare-assigned session id.
 *  The body must be empty — a literal `{}` is parsed by CF as a (malformed)
 *  sessionDescription payload and rejected.
 *
 *  Not retried: a retry after a lost response would orphan the SFU session
 *  created by the first (successful-but-unseen) attempt. A clean failure is
 *  preferable to a leaked session. */
export async function createCfSession(env: Env): Promise<string> {
  const res = await cfFetch(env, '/sessions/new', { method: 'POST' });
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}

/** Publish local tracks. Push offers never require renegotiation. */
export async function addLocalTracks(
  env: Env,
  sid: string,
  offerSdp: string,
  tracks: LocalTrack[],
): Promise<{ answerSdp: string; tracks: CfTrack[] }> {
  const res = await cfFetch(env, `/sessions/${sid}/tracks/new`, {
    method: 'POST',
    body: JSON.stringify({
      sessionDescription: { type: 'offer', sdp: offerSdp },
      tracks: tracks.map((t) => ({
        location: 'local',
        mid: t.mid,
        trackName: t.trackName,
        kind: t.kind,
      })),
    }),
  });
  const data = (await res.json()) as CfTracksResponse;
  return { answerSdp: data.sessionDescription?.sdp ?? '', tracks: data.tracks ?? [] };
}

/** Subscribe to remote tracks. Returns an SFU offer to be answered + renegotiated. */
export async function addRemoteTracks(
  env: Env,
  sid: string,
  refs: RemoteTrackRef[],
): Promise<{ offerSdp: string; tracks: CfTrack[]; requiresImmediateRenegotiation: boolean }> {
  const res = await cfFetch(env, `/sessions/${sid}/tracks/new`, {
    method: 'POST',
    body: JSON.stringify({
      tracks: refs.map((r) => ({
        location: 'remote',
        sessionId: r.sessionId,
        trackName: r.trackName,
      })),
    }),
  });
  const data = (await res.json()) as CfTracksResponse;
  return {
    offerSdp: data.sessionDescription?.sdp ?? '',
    tracks: data.tracks ?? [],
    requiresImmediateRenegotiation: data.requiresImmediateRenegotiation ?? false,
  };
}

/** Complete a subscribe by sending the local answer back to the SFU. */
export async function renegotiate(env: Env, sid: string, answerSdp: string): Promise<void> {
  await cfFetch(env, `/sessions/${sid}/renegotiate`, {
    method: 'PUT',
    body: JSON.stringify({ sessionDescription: { type: 'answer', sdp: answerSdp } }),
  });
}

/** Best-effort close of published tracks on session teardown. The live SFU
 *  close endpoint is `PUT .../tracks/close` keyed by `mid`, and requires
 *  `force`; a `POST` or trackName-keyed body is rejected. */
export async function closeTracks(env: Env, sid: string, mids?: string[]): Promise<void> {
  const tracks = (mids ?? []).map((mid) => ({ mid }));
  if (tracks.length === 0) return;
  await cfFetch(env, `/sessions/${sid}/tracks/close`, {
    method: 'PUT',
    body: JSON.stringify({ tracks, force: true }),
    signal: AbortSignal.timeout(CLOSE_FETCH_TIMEOUT_MS),
  });
}

/** Best-effort release of an entire SFU session on teardown. The Realtime API
 *  has no single "close session" endpoint — a session is reaped once it has no
 *  remaining tracks — so we read the session's live tracks and force-close them
 *  all. Works regardless of which slot/peer owns the session or whether it ever
 *  published, so it cleans up sessions created lazily by `ensurePeer`. */
export async function closeSession(env: Env, sid: string): Promise<void> {
  const res = await cfFetch(env, `/sessions/${sid}`, {
    method: 'GET',
    signal: AbortSignal.timeout(CLOSE_FETCH_TIMEOUT_MS),
  });
  const data = (await res.json()) as { tracks?: { mid?: string }[] };
  const mids = (data.tracks ?? [])
    .map((t) => t.mid)
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
  await closeTracks(env, sid, mids);
}
