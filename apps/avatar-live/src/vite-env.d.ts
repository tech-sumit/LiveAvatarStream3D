/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TTS_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
