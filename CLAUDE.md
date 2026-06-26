# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Standalone project with its own git repository.** It lives at `projects/LiveAvatarStream3D/` inside the `n8n` working tree for convenience but is **independent of the parent n8n automation stack** — different product, its own `.git`. Ignore the parent `n8n/CLAUDE.md`, Docker Compose, Vault, Parallels VM, NemoClaw. Commit/push to **this** repo. Remote: `git@github.com:tech-sumit/LiveAvatarStream3D.git`. **Push to `main` is blocked — branch + PR + merge.**

> Authoritative design docs live in `docs/specs/`. The active redesign is **`docs/specs/2026-06-25-performance-score-dsl-design.md`** (a parameterized Score/Stage performance model) plus **`docs/specs/2026-06-25-webmcp-studio-control-design.md`** (in-browser WebMCP control). When older specs disagree, the newest wins.

## What this is

A **browser-based 3D talking-avatar studio.** You author a performance (a script plus
emotion/gesture/camera direction) and the browser renders a lip-synced 3D avatar in real time
(Three.js) and exports a 1080p/4K MP4 **entirely client-side** (WebCodecs). There is no GPU
render server. A Cloudflare control plane handles voice cloning, avatar assets, and
project/asset persistence (R2/D1).

> **History:** this repo used to host several render paths — a headless `engine-three` Node
> renderer, a 2D EchoMimicV3 path, and a MuseTalk realtime path. `engine-three` was removed;
> the 2D + MuseTalk paths were relocated to the sibling repo `../LiveAvatarStream`. This repo is
> now **3D-browser-only**.

## Workspace layout (npm workspaces, Node ≥20)

| Workspace | Role |
|---|---|
| `apps/avatar-live` (`@las/avatar-live`) | **The studio.** Vanilla TS + Three.js. Author a script with `[emotion][gesture]` tags → the browser renders the avatar speaking it lip-synced → export an MP4 (WebCodecs). The rig drives glTF ARKit/Oculus blendshapes or a procedural head; locomotion + gestures come from Mixamo-retargeted clips; TTS is ElevenLabs or Web Speech. `npm run dev:avatar` → http://localhost:5175. |
| `packages/protocol` (`@las/protocol`) | Shared TS contracts: the DSL (`dsl.ts`), the studio bridge (`bridge.ts`), `NewsReportDoc` + its compiler (`newsreport.ts`, `newsreportCompile.ts`), the LLM director (`director.ts`), and voice/avatar/job/event contracts. zod → JSON Schema (`npm run protocol:schema`). |
| `services/control-api` | Cloudflare Hono Worker. Routes in `src/routes/` (voices, avatars, director, jobs, uploads, internal), `orchestrator.ts` (the `voice_clone` + `avatar_build` jobs), GPU dispatch `gpu/provider.ts`, `do/JobDO.ts`, D1 + R2 + Queues. |
| `services/gpu/` | Python GPU services the control plane still uses: `voice/` (TTS clone), `avatar-build/` (build a rigged avatar from a reference), `image-gen/` (back-screen card imagery). Plus `common/`, `deploy/` (pod bring-up), `modal_app.py`. |
| `services/newsroom-mcp` (`@las/newsroom-mcp`) | stdio MCP that drives the studio over the `@las/protocol` bridge (set newscast, generate cards/music, export). Being superseded by an in-browser WebMCP server — see the WebMCP design spec. |

## Common commands (from project root)
```bash
npm install
npm run dev:avatar     # the studio → http://localhost:5175
npm run dev:api        # control-api wrangler dev
npm run typecheck      # all workspaces (--if-present)
npm test               # protocol has vitest (dsl.test.ts)
npm run protocol:schema
npm run build --workspace @las/avatar-live   # studio bundle → apps/avatar-live/dist/
```
Deploy control-api: `cd services/control-api && wrangler deploy`.

> **`@las/performer-core`** (the framework-agnostic pure-math performance runtime — the Score/Stage redesign foundation) emits a **gitignored `dist/`**. `npm install` rebuilds it via the package's `prepare` script; its consumers (`@las/protocol`, `@las/avatar-live`) won't typecheck/build until that dist exists, so **after pulling, run `npm install`**.

## The studio (`apps/avatar-live`) — how a performance runs
- **Script → segments:** `src/avatar/gestures.ts` parses `[emotion][gesture]` tags (plus keyword inference) into per-sentence drives.
- **Drive loop:** `src/app/performer.ts` runs both the live preview (rAF) and the frame-exact offline export (`src/capture/offlineExporter.ts`, WebCodecs) off one path. `src/scene/stage.ts` owns the camera; `src/avatar/avatarController.ts` owns body/face/gesture/locomotion.
- **Export is client-side + synchronous** — it renders frame-by-frame in the browser (works even in a backgrounded tab). The live *preview* rAF loop pauses when the tab is hidden, so realtime motion can't be exercised in a hidden/automation tab; the export still can.
- `.env.development` `VITE_API_URL` should point at the **deployed Worker** (cloned voices live on the deployed D1/R2, not a local wrangler dev).

## Active redesign — read before extending the studio
The studio's camera/motion/gesture systems are currently **imperative + enumerated**, so each
new creative idea tends to need a code change. The approved redesign
(`docs/specs/2026-06-25-performance-score-dsl-design.md`) replaces this with a **parameterized,
spatial, compositional Score/Stage model** run by one shared interpreter, so direction becomes
*data* not code. Prefer extending toward that model over adding more hardcoded gestures/shots.

## Conventions & gotchas
- **DSL vocabularies live in `packages/protocol`**; regenerate schema after changes (`npm run protocol:schema`).
- POC user is hardcoded `demo-user`.
- Do **not** add retries to recording/render jobs — failures should surface loudly.
- No CI. Validate with `npm run typecheck`, the protocol tests, and a studio smoke test.
- Push to `main` is blocked — branch + PR + merge.

## Root reference docs
`docs/specs/*` (design specs — start with the 2026-06-25 ones), `ARCHITECTURE.md`,
`PRODUCT_SPEC.md`, `ROADMAP.md`, `OPERATIONS.md`, `progress.md`.
