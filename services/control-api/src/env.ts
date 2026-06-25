/** Cloudflare bindings for the control plane. No auth bindings yet (internal tool). */
export interface Env {
  // Storage
  DB: D1Database;
  ASSETS: R2Bucket;
  AVATARS: R2Bucket;
  VOICES: R2Bucket;
  OUTPUTS: R2Bucket;
  CACHE: KVNamespace;

  // Async + coordination
  JOBS: Queue;
  JOB_DO: DurableObjectNamespace;

  // Config / secrets (wrangler vars + secrets)
  INTERNAL_SERVICE_TOKEN: string;
  GPU_PROVIDER: string;
  GPU_PROVIDER_BASE_URL: string;
  GPU_PROVIDER_TOKEN: string;
  DIRECTOR_LLM_PROVIDER: string;
  DIRECTOR_LLM_MODEL: string;
  ANTHROPIC_API_KEY: string;
  R2_PUBLIC_BASE?: string;
}
