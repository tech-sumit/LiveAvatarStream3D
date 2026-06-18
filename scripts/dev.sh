#!/usr/bin/env bash
# Local dev: control-api (wrangler) + web (vite) together.
# Requires `npm install` at the repo root first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run build --workspace @las/protocol

# control-api on :8787, web on :5173 (proxies /api -> :8787, see vite.config.ts)
npx concurrently -n api,web -c blue,green \
  "npm run dev --workspace @las/control-api" \
  "npm run dev --workspace apps/web"
