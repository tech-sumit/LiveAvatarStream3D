# Setup

> **Historical (pre-2026-06-26)** — describes the earlier multi-path product. See the root
> README and `docs/specs/` for the current 3D-browser-only studio.
>
> The repo is now **3D-browser-only** (see `ARCHITECTURE.md`'s scope note
> and `CLAUDE.md`). The realtime/SFU pieces and the `avatar-video`/`finishing`/`realtime` GPU
> services moved to `../LiveAvatarStream`. For the current studio, setup is just:
>
> ```bash
> npm install            # also rebuilds @las/performer-core's gitignored dist/
> npm run dev:avatar     # the studio → http://localhost:5175
> npm run dev:api        # control-api wrangler dev (optional; point VITE_API_URL
>                        # at the deployed Worker for cloned voices)
> ```
>
> The Cloudflare provisioning + GPU-plane sections below still apply to the control plane's
> remaining services (`services/gpu/{voice,avatar-build,image-gen}`); realtime bits do not.

Internal tool — no auth layer. Gate access with VPN / port-forward for demos.

## Prerequisites

- Node 20+
- A Cloudflare account (Workers, D1, R2, KV, Queues, Durable Objects)
- A GPU plane for voice-clone / avatar-build / image-gen: Modal account (default)
  **or** Runpod/CoreWeave pods
- An Anthropic API key (director LLM)
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
| `CF_REALTIME_APP_ID` / `CF_REALTIME_APP_SECRET` | (Historical — realtime path moved to `../LiveAvatarStream`) |
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
# NOTE: scripts/gpu/build.sh predates the consolidation and still loops over the
# removed avatar-video / finishing / realtime services (their Dockerfiles are gone,
# so those iterations fail). Build the three that remain individually:
for svc in avatar-build image-gen voice; do
  docker build -f "services/gpu/$svc/Dockerfile" -t "<registry>/las-$svc:v1" .
done
# push + run each on your GPU host(s); point GPU_PROVIDER_BASE_URL at them
```

## 4. Deploy the control plane

```bash
# scripts/deploy-cf.sh predates the consolidation — its second half deploys the
# removed apps/web to Pages and fails. Deploy the Worker directly:
npm run build --workspace @las/protocol
npm run deploy --workspace @las/control-api      # = cd services/control-api && wrangler deploy
```

## Local development

```bash
# scripts/dev.sh predates the consolidation (it starts the removed apps/web). Use:
npm run dev:avatar   # the studio → http://localhost:5175
npm run dev:api      # control-api wrangler dev → http://localhost:8787
```

Verify the GPU round-trip once the plane is reachable:

```bash
curl -X POST https://<worker>/api/_health/gpu      # enqueues a health_check job
curl https://<worker>/api/jobs/<jobId>             # should reach status=succeeded
```
