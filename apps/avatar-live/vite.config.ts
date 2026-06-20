import { defineConfig } from 'vite';

// Realtime avatar app. Port 5175 to avoid clashing with the scene editor (5174)
// and the web app. Env: VITE_TTS_URL (optional) points at a server TTS endpoint
// for cloned-voice playback; defaults to the in-browser Web Speech voice.
export default defineConfig({
  server: { port: 5175, host: true },
  build: { target: 'es2022' },
});
