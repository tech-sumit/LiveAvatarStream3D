# Operations

> **⚠️ Scope note (2026-06-26):** Historical — this doc describes the pre-2026-06-26
> multi-path product; the repo is now **3D-browser-only** (see `ARCHITECTURE.md`'s scope note
> and `CLAUDE.md`). The GPU render/realtime paths (`avatar-video`, `finishing`, `realtime`,
> `SessionDO`) moved to `../LiveAvatarStream` or were removed. What still runs from this repo:
> the studio (`npm run dev:avatar` → http://localhost:5175), the control-api Worker
> (`cd services/control-api && npx wrangler deploy`), and three GPU services the control plane
> uses (`services/gpu/{voice,avatar-build,image-gen}`). Sections below are annotated where
> they no longer apply.

Day-to-day running notes for the internal deployment.

## Topology

- **Control plane** — one Cloudflare Worker (`@las/control-api`) + D1 + R2 + KV +
  Queues + one Durable Object class (`JobDO`). (`SessionDO` was removed with the
  realtime path.)
- **GPU plane** — three containerized services remain (`avatar-build`, `image-gen`,
  `voice`) on Modal or self-hosted pods; `avatar-video`, `finishing`, and `realtime`
  moved to `../LiveAvatarStream`.
- **Web** — the studio (`apps/avatar-live`) is a Vite app; there is no `apps/web`
  Pages SPA anymore.

## Offline render lifecycle (historical)

> Rendering is now client-side in the studio (WebCodecs MP4 export) — there is no
> GPU render job. The Queue/orchestrator still exists but runs `voice_clone` and
> `avatar_build` jobs only (`services/control-api/src/orchestrator.ts`).

`POST /api/jobs` → D1 row + Queue message → consumer `handleQueue`:

```
voice/tts  ->  avatar-video/render  ->  finishing/finish  ->  R2 OUTPUTS/<job>.mp4
```

Status is written to D1 (`jobs`, `job_events`) and pushed to `JobDO`. The web
app polls `GET /api/jobs/:id`; a WebSocket is available at
`GET /api/jobs/:id/subscribe`.

## Realtime session lifecycle (historical — moved to `../LiveAvatarStream`)

`POST /api/sessions` → `SessionDO.start`:

1. Mint TURN creds + compute SFU WHIP/WHEP endpoints (Cloudflare Realtime).
2. Allocate a warm GPU node (`realtime` service) and hand it the SFU info.
3. Browser publishes mic (WHIP) + subscribes to avatar (WHEP).

Conversation loop: GPU STT → `POST /api/sessions/:id/turn` → director LLM stream
in `SessionDO` → DSL segments → GPU `…/dsl` → streaming TTS + talking-head → SFU.

**Barge-in:** the browser sends `barge_in` on the control channel → `SessionDO`
bumps the turn epoch → cancels the in-flight LLM stream and posts a `cancel` to
the GPU worker, which drains its audio/video queues immediately.

## Common tasks

| Task | Command |
|---|---|
| Run the studio | `npm run dev:avatar` → http://localhost:5175 |
| Typecheck + tests (CI mirrors this) | `npm run typecheck && npm test` |
| Tail worker logs | `npx wrangler tail --name las-control-api` |
| Inspect a job | `npx wrangler d1 execute las_db --remote --command "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 10"` |
| Re-run migrations | `npm run migrate:remote --workspace @las/control-api` |
| GPU health round-trip | `curl -X POST https://<worker>/api/_health/gpu` (needs a live GPU plane) |
| Redeploy worker | `npm run deploy --workspace @las/control-api` |
| Redeploy GPU plane | `modal deploy services/gpu/modal_app.py` (voice / avatar-build / image-gen only) |

## Latency budgets (realtime — historical, moved to `../LiveAvatarStream`)

- Steady-state motion-to-photon: **< 150 ms** (fast tier, `tiers.py`).
- Turn response (end-of-speech → avatar starts speaking): **~0.8–1.5 s**.

If turn latency regresses: check STT endpointing (800 ms silence in `stt.py`),
director TTFB, and TTS time-to-first-audio. If steady-state stutters: confirm
`min_containers` keeps a warm realtime node and that NVENC/CUDA-graph paths are
active.

## Cost levers

- Offline GPU (Modal) scales to zero between jobs.
- (Historical) realtime warm nodes and render tiers moved to `../LiveAvatarStream`;
  rendering here is client-side and free.

## Cleanup

`npx wrangler r2 object delete` for stale `work/<jobId>` intermediates in
`las-outputs`. (There is no `npm run clean` script in any workspace.)
