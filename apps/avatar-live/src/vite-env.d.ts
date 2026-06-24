/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TTS_URL?: string;
  /** Studio Bridge: when set (a port, "1", or "true"), connect to ws://127.0.0.1:<port>. */
  readonly VITE_BRIDGE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// three ships this addon without bundled types.
declare module 'three/addons/libs/meshopt_decoder.module.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const MeshoptDecoder: any;
}
