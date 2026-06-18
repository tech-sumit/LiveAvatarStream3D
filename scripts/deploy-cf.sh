#!/usr/bin/env bash
# Deploy the control-plane Worker and the web app (Cloudflare Pages).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run build --workspace @las/protocol

echo "==> Deploy control-api Worker"
npm run deploy --workspace @las/control-api

echo "==> Build + deploy web (Pages)"
npm run build --workspace apps/web
npx wrangler pages deploy apps/web/dist --project-name las-web
