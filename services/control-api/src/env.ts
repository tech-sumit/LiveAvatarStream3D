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
  SESSION_DO: DurableObjectNamespace;

  // Config / secrets (wrangler vars + secrets)
  INTERNAL_SERVICE_TOKEN: string;
  GPU_PROVIDER: string;
  GPU_PROVIDER_BASE_URL: string;
  GPU_PROVIDER_TOKEN: string;
  DIRECTOR_LLM_PROVIDER: string;
  DIRECTOR_LLM_MODEL: string;
  ANTHROPIC_API_KEY: string;
  // Cloudflare Realtime SFU (Calls) app — drives WHIP/WHEP + sessions/tracks.
  CF_REALTIME_APP_ID: string;
  CF_REALTIME_APP_SECRET: string;
  // Cloudflare TURN key — a separate resource used only to mint ephemeral ICE creds.
  CF_TURN_KEY_ID: string;
  CF_TURN_KEY_API_TOKEN: string;
  R2_PUBLIC_BASE?: string;
}
