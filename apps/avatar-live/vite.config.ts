import { defineConfig, loadEnv } from 'vite';

// Realtime avatar app. Port 5175 to avoid clashing with the scene editor (5174)
// and the web app.
//
// ElevenLabs: set ELEVENLABS_API_KEY in apps/avatar-live/.env (NOT prefixed with
// VITE_, so it stays server-side). The dev server proxies `/eleven/*` to the
// ElevenLabs API and injects the xi-api-key header — the key never reaches the
// browser and there is no CORS issue. (For production, front the API with an
// equivalent proxy / Worker.)
//
// Optional A2F: VITE_A2F_URL points at an Audio2Face-3D HTTP wrapper.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const elevenKey = env.ELEVENLABS_API_KEY;
  return {
    server: {
      port: 5175,
      host: true,
      proxy: elevenKey
        ? {
            '/eleven': {
              target: 'https://api.elevenlabs.io',
              changeOrigin: true,
              rewrite: (p) => p.replace(/^\/eleven/, '/v1'),
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyReq) => {
                  proxyReq.setHeader('xi-api-key', elevenKey);
                });
              },
            },
          }
        : undefined,
    },
    build: { target: 'es2022' },
  };
});
