import type { Env } from '../env.js';
import { fetchWithRetry, type RetryOpts } from '../lib/retry.js';

export type GpuService =
  | 'avatar-build'
  | 'image-gen'
  | 'voice'
  | 'finishing'
  | 'engine-three';

/**
 * Abstraction over where GPU inference runs. Modal (serverless, autoscale-to-
 * zero) backs offline jobs; Runpod/CoreWeave persistent pods back the engine
 * renderer. Swapping providers means swapping this implementation only.
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
}

class HttpGpuProvider implements GpuProvider {
  constructor(
    private baseUrl: string,
    private token: string,
    private internalToken: string,
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
}

export function makeGpuProvider(env: Env): GpuProvider {
  // Provider selection is by config; the HTTP shape is shared across Modal /
  // Runpod / CoreWeave so one implementation covers them via base URL.
  return new HttpGpuProvider(
    env.GPU_PROVIDER_BASE_URL,
    env.GPU_PROVIDER_TOKEN ?? '',
    env.INTERNAL_SERVICE_TOKEN,
  );
}
