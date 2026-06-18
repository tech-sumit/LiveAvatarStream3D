# Operations

Day-to-day running notes for the internal deployment.

## Topology

- **Control plane** — one Cloudflare Worker (`@las/control-api`) + D1 + R2 + KV +
  Queues + two Durable Object classes (`JobDO`, `SessionDO`).
- **GPU plane** — six containerized services (`avatar-build`, `image-gen`,
  `voice`, `avatar-video`, `finishing`, `realtime`) on Modal or self-hosted H100s.
- **Web** — static SPA on Cloudflare Pages, proxying `/api/*` to the Worker.

## Offline render lifecycle

`POST /api/jobs` → D1 row + Queue message → consumer `handleQueue`:

```
voice/tts  ->  avatar-video/render  ->  finishing/finish  ->  R2 OUTPUTS/<job>.mp4
```

Status is written to D1 (`jobs`, `job_events`) and pushed to `JobDO`. The web
app polls `GET /api/jobs/:id`; a WebSocket is available at
`GET /api/jobs/:id/subscribe`.

## Realtime session lifecycle

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
| Tail worker logs | `npx wrangler tail --name las-control-api` |
| Inspect a job | `npx wrangler d1 execute las_db --remote --command "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 10"` |
| Re-run migrations | `npm run migrate:remote --workspace @las/control-api` |
| GPU health round-trip | `curl -X POST https://<worker>/api/_health/gpu` |
| Quality eval a render | `python scripts/eval/eval.py --generated out.mp4 --ref-image face.png` |
| Redeploy worker | `npm run deploy --workspace @las/control-api` |
| Redeploy GPU plane | `modal deploy services/gpu/modal_app.py` |

## Latency budgets (realtime)

- Steady-state motion-to-photon: **< 150 ms** (fast tier, `tiers.py`).
- Turn response (end-of-speech → avatar starts speaking): **~0.8–1.5 s**.

If turn latency regresses: check STT endpointing (800 ms silence in `stt.py`),
director TTFB, and TTS time-to-first-audio. If steady-state stutters: confirm
`min_containers` keeps a warm realtime node and that NVENC/CUDA-graph paths are
active.

## Cost levers

- Offline GPU (Modal) scales to zero between jobs.
- Realtime keeps `REALTIME_WARM` nodes hot — set to 0 to save cost at the price
  of cold-start on first session.
- Premium tier (OmniAvatar + RIFE) is the expensive path; default live sessions
  to the `fast` tier.

## Cleanup

`npm run clean` (per workspace) and `npx wrangler r2 object delete` for stale
`work/<jobId>` intermediates in `las-outputs`.
