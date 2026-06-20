/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TTS_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// three ships this addon without bundled types.
declare module 'three/addons/libs/meshopt_decoder.module.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const MeshoptDecoder: any;
}
