#!/usr/bin/env bash
# One-time Cloudflare resource provisioning for the control plane.
# Creates D1, KV, Queue, and R2 buckets, then prints the ids to paste into
# services/control-api/wrangler.toml. No auth resources (internal tool).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../services/control-api"

echo "==> R2 buckets"
for b in las-assets las-avatars las-voices las-outputs; do
  npx wrangler r2 bucket create "$b" || true
done

echo "==> KV namespace"
npx wrangler kv namespace create CACHE || true

echo "==> Queue"
npx wrangler queues create las-jobs || true

echo "==> D1 database"
npx wrangler d1 create las_db || true

cat <<'NOTE'

Next steps:
  1. Paste the printed D1 database_id and KV id into wrangler.toml
     (REPLACE_WITH_D1_ID / REPLACE_WITH_KV_ID).
  2. Apply migrations:        npm run migrate:remote --workspace @las/control-api
  3. Set secrets:
       npx wrangler secret put INTERNAL_SERVICE_TOKEN
       npx wrangler secret put GPU_PROVIDER_TOKEN
       npx wrangler secret put ANTHROPIC_API_KEY
       npx wrangler secret put CF_REALTIME_APP_SECRET
  4. Deploy:                  ./scripts/deploy-cf.sh
NOTE
