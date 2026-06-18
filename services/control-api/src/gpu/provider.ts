import type { Env } from '../env.js';
import type { IceServer, StartSessionRequest } from '@las/protocol';
import { fetchWithRetry, type RetryOpts } from '../lib/retry.js';

export type GpuService =
  | 'avatar-build'
  | 'image-gen'
  | 'voice'
  | 'avatar-video'
  | 'finishing'
  | 'realtime';

/** SFU connection info the control plane hands to the GPU worker. The GPU
 *  drives the SFU itself via the control-plane /rt/* routes; it only needs
 *  ICE servers for NAT traversal. */
export interface SessionMediaInfo {
  iceServers: IceServer[];
}

export interface SessionAllocation {
  node: string;
}

/**
 * Abstraction over where GPU inference runs. Modal (serverless, autoscale-to-
 * zero) backs offline jobs; Runpod/CoreWeave persistent pods back the realtime
 * warm pool. Swapping providers means swapping this implementation only.
 */
export interface GpuProvider {
  /** Resolve the base URL for a given containerized service. */
  serviceUrl(service: GpuService): string;
  /**
   * POST JSON to a service endpoint with the internal auth header. Optional
   * `retry` overrides the default short transient-retry policy — used by
   * cold-start-sensitive callers that must ride through a pod warm-up.
   */
  call<T>(service: GpuService, path: string, body: unknown, retry?: RetryOpts): Promise<T>;
  /** End-to-end health-check used by the Phase 0 round-trip. */
  health(): Promise<boolean>;
  /** Allocate a warm realtime node and hand it the SFU connection info. */
  startSession(
    sessionId: string,
    req: StartSessionRequest,
    media: SessionMediaInfo,
  ): Promise<SessionAllocation>;
  /** Release a realtime node back to the pool. */
  stopSession(node: string, sessionId?: string): Promise<void>;
}

class HttpGpuProvider implements GpuProvider {
  constructor(
    private baseUrl: string,
    private token: string,
    private internalToken: string,
    private realtimeAppId: string,
  ) {}

  serviceUrl(service: GpuService): string {
    // Modal routes per-service subpaths; persistent pods can map the same shape.
    return `${this.baseUrl.replace(/\/$/, '')}/${service}`;
  }

  async call<T>(service: GpuService, path: string, body: unknown, retry?: RetryOpts): Promise<T> {
    const res = await fetchWithRetry(
      `${this.serviceUrl(service)}${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
          'x-internal-token': this.internalToken,
        },
        body: JSON.stringify(body),
      },
      // GPU routes are all known-good, so a 404 here is the RunPod proxy not yet
      // having the upstream ready — transient. Ride through it (callers may still
      // override attempts/backoff for cold starts).
      { retry404: true, ...retry },
    );
    if (!res.ok) {
      throw new Error(`gpu ${service}${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.serviceUrl('avatar-build')}/health`, {
        headers: { authorization: `Bearer ${this.token}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async startSession(
    sessionId: string,
    req: StartSessionRequest,
    media: SessionMediaInfo,
  ): Promise<SessionAllocation> {
    // `call` retries via fetchWithRetry; this is safe only because the GPU
    // /sessions endpoint is idempotent on sessionId — a retry after a lost
    // response returns the existing allocation instead of double-allocating.
    return this.call<SessionAllocation>('realtime', '/sessions', { sessionId, ...req, media });
  }

  async stopSession(node: string, sessionId?: string): Promise<void> {
    await this.call('realtime', '/sessions/stop', { node, sessionId }).catch(() => undefined);
  }
}

export function makeGpuProvider(env: Env): GpuProvider {
  // Provider selection is by config; the HTTP shape is shared across Modal /
  // Runpod / CoreWeave so one implementation covers them via base URL.
  return new HttpGpuProvider(
    env.GPU_PROVIDER_BASE_URL,
    env.GPU_PROVIDER_TOKEN ?? '',
    env.INTERNAL_SERVICE_TOKEN,
    env.CF_REALTIME_APP_ID,
  );
}
