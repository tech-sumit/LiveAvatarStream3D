import { defineConfig } from 'vitest/config';

// Dedicated vitest config (NOT the app vite.config, whose plugins scan dirs / load env).
// Phase 4a parity tests are pure-number node tests — no DOM, no THREE, no app plugins.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
