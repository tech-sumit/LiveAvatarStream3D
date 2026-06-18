# Setup

Internal tool — no auth layer. Gate access with VPN / port-forward for demos.

## Prerequisites

- Node 20+
- A Cloudflare account (Workers, D1, R2, KV, Queues, Durable Objects, Realtime)
- A GPU plane: Modal account (default) **or** Runpod/CoreWeave pods with the
  service images from `scripts/gpu/build.sh`
- An Anthropic API key (director LLM, Claude Opus 4.8)
- `ffmpeg` (only for running GPU services locally)

## 1. Install + configure

```bash
npm install
cp .env.example .env   # fill in keys (see below)
```

Key env values:

| Var | Purpose |
|---|---|
| `INTERNAL_SERVICE_TOKEN` | Shared token between control plane and GPU services |
| `GPU_PROVIDER_BASE_URL` | Base URL of the deployed GPU plane |
| `ANTHROPIC_API_KEY` | Director LLM |
| `CF_REALTIME_APP_ID` / `CF_REALTIME_APP_SECRET` | Cloudflare Realtime SFU + TURN |
| `R2_*` | S3-compatible creds for GPU services to read/write R2 |

## 2. Provision Cloudflare

```bash
./scripts/provision-cf.sh
# paste the printed D1 + KV ids into services/control-api/wrangler.toml
npm run migrate:remote --workspace @las/control-api
# set worker secrets
cd services/control-api
npx wrangler secret put INTERNAL_SERVICE_TOKEN
npx wrangler secret put GPU_PROVIDER_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CF_REALTIME_APP_SECRET
```

## 3. Deploy the GPU plane (Modal default)

```bash
modal secret create las-gpu \
  R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
  CONTROL_API_URL=https://<your-worker> INTERNAL_SERVICE_TOKEN=... ANTHROPIC_API_KEY=...
modal deploy services/gpu/modal_app.py
# set GPU_PROVIDER_BASE_URL to the deployed base, then redeploy the worker
```

Self-hosted pods instead of Modal:

```bash
REGISTRY=<registry> TAG=v1 ./scripts/gpu/build.sh   # build all 6 images
# push + run each on your H100 host(s); point GPU_PROVIDER_BASE_URL at them
```

## 4. Deploy control plane + web

```bash
./scripts/deploy-cf.sh
```

## Local development

```bash
./scripts/dev.sh   # control-api on :8787, web on :5173
```

Verify the GPU round-trip once the plane is reachable:

```bash
curl -X POST https://<worker>/api/_health/gpu      # enqueues a health_check job
curl https://<worker>/api/jobs/<jobId>             # should reach status=succeeded
```
