/** Cloudflare bindings for the control plane. Auth is optional/env-gated (POC). */
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

  // Optional hardening — both unset keeps the open POC behavior.
  /** Secret; when set, /api/* requires `Authorization: Bearer <API_TOKEN>` (lib/auth.ts). */
  API_TOKEN?: string;
  /** Comma-separated origins; when set, CORS is restricted to these (index.ts). */
  ALLOWED_ORIGINS?: string;
}
