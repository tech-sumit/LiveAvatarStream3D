# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **This is a standalone project with its own git repository.** It lives at `projects/LiveAvatarStream3D/` inside the `n8n` working tree for convenience, but it is **independent of the parent n8n automation stack** — different product, different deploy targets, its own `.git`. Ignore the parent `n8n/CLAUDE.md`, Docker Compose stack, Vault, Parallels VM, and NemoClaw: none of it applies here. Commit and push work to **this** repo's git, not the parent's. Treat this directory as the repo root. The remote (where work is committed, pushed, and deployed from) is `git@github.com:tech-sumit/LiveAvatarStream3D.git`.

> Authoritative status/planning docs live in `docs/specs/`. **Start with `docs/specs/2026-06-20-project-context.md`.** When `docs/specs/*` disagrees with `progress.md` or `docs/scene-editor-architecture.md` on scene-editor / WYSIWYG topics, the specs win (Jun 20, 2026).

## What this is

Open-source HeyGen-style avatar video pipeline. A user uploads a reference video (→ avatar) and a voice sample (→ clone), writes a performance script (DSL), and renders 1080p/4K mp4 on an H100 GPU. A future realtime tier streams a live LLM-directed avatar over WebRTC.

The central architectural constraint: **Cloudflare Workers have no GPU.** The system splits into a **control plane** (Cloudflare: web, API, D1, R2, Queues, Durable Objects, Realtime SFU) and a **GPU plane** (external H100 RunPod: Python inference + the `engine-three` Node renderer). The TypeScript DSL/job contracts in `packages/protocol` are the single source of truth, exported to JSON Schema so the Python side stays in sync.

Two render paths share one control plane:
- **2D cinematic** — EchoMimicV3 + GFPGAN + RIFE (validated Jun 18, 2026)
- **3D cinematic** — `engine-three` headless WebGL, scene-editor WYSIWYG (validated Jun 19, 2026)
- **Realtime** — MuseTalk + XTTS + Cloudflare SFU (code present, gated on Cloudflare Realtime secrets)

## Workspace layout (npm workspaces, Node ≥20)

| Workspace | Plane | Role |
|---|---|---|
| `packages/protocol` (`@las/protocol`) | shared TS | DSL (`dsl.ts`), `PerformanceManifest` (`manifest.ts`), `SceneDocument`/`EngineRenderSpec` (`scene.ts`, `jobs.ts`), job/event/director/voice contracts. zod schemas → JSON Schema. |
| `services/control-api` | Cloudflare | Hono Worker. Routes in `src/routes/`, orchestration in `orchestrator.ts`, GPU dispatch via `gpu/provider.ts`, queue consumer + Durable Objects (`do/JobDO.ts`, `do/SessionDO.ts`). |
| `services/engine-three` | GPU pod | Headless Three.js renderer (Node 20 + `gl` + Xvfb). HTTP server `src/server.ts`; render pipeline `render.ts` → `stage.ts`/`sceneGraph.ts`/`timeline.ts`/`camera.ts`; face lip-sync under `src/face/` + `src/avatar/`. |
| `services/gpu/` | GPU pod | Python FastAPI services: `voice/`, `avatar-build/`, `avatar-video/` (EchoMimicV3), `finishing/` (restore/SR/RIFE/NVENC), `image-gen/`, `realtime/` (MuseTalk). `deploy/` = pod bring-up (nginx, supervisord, validators). |
| `apps/scene-editor` | browser | **three.js editor + LAS Render tab** (see below). |
| `apps/web` | browser | Vite + React webapp (Cloudflare Pages). |

## Common commands (run from project root)

```bash
npm install                 # workspaces
npm run dev:editor          # scene editor → http://localhost:5174
npm run dev:web             # web app
npm run dev:api             # control-api wrangler dev
npm run typecheck           # all workspaces (--if-present)
npm run lint                # eslint .
npm run format              # prettier --write .
npm test                    # all workspaces; protocol has vitest (dsl.test.ts, manifest.test.ts)
npm run protocol:schema     # regenerate JSON Schema from @las/protocol zod
```

Run one protocol test: `npm test --workspace @las/protocol -- manifest.test.ts`.
Build the editor bundle: `npm run build --workspace apps/scene-editor` → `apps/scene-editor/dist/`.

Deploy control-api: `cd services/control-api && wrangler deploy` (confirm `GPU_PROVIDER_BASE_URL` in `wrangler.toml` matches the live pod gateway).

### GPU pod ops (`scripts/gpu/`)
```bash
./scripts/gpu/spawn-pod.sh --info             # POD_ID, gateway, SSH, cost/hr
./scripts/gpu/health-roundtrip.sh [--direct|--worker]
POD_SSH=root@<host> POD_SSH_PORT=<port> LAS_SSH_KEY=~/.ssh/las_runpod \
  ./scripts/gpu/sync-engine-three.sh          # push local engine-three to pod
```
End-to-end validators (need live pod + deployed Worker), with `CONTROL_API_URL=...`:
`services/gpu/deploy/validate_offline.py` (2D), `validate_engine_render.py` (3D).

## Scene editor (`apps/scene-editor`) — important: this is NOT a custom React app

Current `main` extends the **upstream three.js editor** (vendored under `js/`) with a thin LAS layer. Do not reintroduce a custom editor; the upstream editor handles all scene authoring (import GLB, lights, materials, undo).

- `js/las/` — integration layer: `api.js` (control-api client), `exportScene.js` (editor state → `SceneDocument` → `EngineRenderSpec`), `voices.js` (dedupe), `LasSceneSeed.js`/`LasBootstrap.js` (default Lee Perry-Smith scene).
- `js/Sidebar.LAS.js` — the **Render** tab (default tab): voice dropdown, single script line, Record → `POST /api/engine-jobs` → poll job.
- The previous custom React + Vite editor is preserved on git branch **`backup/custom-scene-editor`** (commit `bd2d5cb`). Restore with `git checkout backup/custom-scene-editor -- apps/scene-editor`.

The editor's `.env.development` must point `VITE_API_URL` at the **deployed Worker** (`https://las-control-api.tech-sumit.workers.dev/api`), not local `wrangler dev` — local dev has isolated D1/R2 so cloned voices won't be found on the GPU.

## WYSIWYG render path (how the editor camera reaches the MP4)

When `EngineRenderSpec.scene` is set: editor `sceneToEngineRenderSpec()` → `POST /api/engine-jobs` → orchestrator runs TTS → `compileManifest({ scene })` → writes R2 `work/{jobId}/manifest.json` → pod `engine-three POST /render` reads it. If `manifest.scene` is present the pod runs `setupEditorScene()` with the frozen viewport camera; if absent (old pod build) it falls back to a procedural placeholder.

**The recurring failure mode:** MP4 shows a placeholder/stick figure or wrong camera while the manifest is correct → the pod is running a **stale `engine-three` binary**. Fix by running `sync-engine-three.sh` and verifying `/engine-three/health` reports `wysiwygScene: true` and `leePerrySmithLoaded: true`. This is rarely an editor/data bug.

## Conventions & gotchas

- **DSL vocabularies are enumerated in `packages/protocol`** (`emotion`, `gesture`, `posture`). Change them there, then `npm run protocol:schema`.
- Use the **full** job id (e.g. `job_mqlg8hks28a55068fcd0`) for R2 manifest lookups, not a truncated prefix. The manifest does not exist during early `tts` status — it's written in `compiling`.
- POC user is hardcoded `demo-user` across editor and web.
- Do **not** add retries to recording/render jobs — failures should surface loudly.
- No CI. Validate with `npm run typecheck`, the protocol tests, `health-roundtrip.sh`, and the GPU validators. Quality of renders is gated by `scripts/eval/` (Sync-C/D, ArcFace, FID/FVD).
- Stop the pod when not rendering — idle H100 cost dominates.

## Root reference docs
`ARCHITECTURE.md` (full control/GPU-plane design, R2 layout, D1 schema, model stack/licenses), `PRODUCT_SPEC.md`, `ROADMAP.md`, `OPERATIONS.md`, `progress.md` (validation log), `services/gpu/deploy/POD_SETUP.md` + `WEIGHTS.md` (pod bring-up).
