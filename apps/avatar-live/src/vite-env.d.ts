/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TTS_URL?: string;
  /** Studio Bridge: when set (a port, "1", or "true"), connect to ws://127.0.0.1:<port>. */
  readonly VITE_BRIDGE?: string;
  /** Deployed control-api base (includes the `/api` segment), e.g.
   *  https://<your-worker>.workers.dev/api. Cloned voices live on the
   *  deployed D1/R2, so the voice manager talks to this Worker, not local wrangler. */
  readonly VITE_API_URL?: string;
  /** Optional bearer for the control-api — must match the Worker's API_TOKEN
   *  secret; sent as `Authorization: Bearer` on VITE_API_URL fetches. NOTE:
   *  VITE_-prefixed vars are baked into the browser bundle — fine for the
   *  single-user POC, not a real secret store. */
  readonly VITE_API_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// three ships this addon without bundled types.
declare module 'three/addons/libs/meshopt_decoder.module.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const MeshoptDecoder: any;
}
