# LiveAvatarStream — Roadmap

End-to-end build sequence. Each phase has an explicit exit criterion. This is an internal tool, so auth/consent/hardening are deferred (see bottom).

```mermaid
gantt
  title LiveAvatarStream build
  dateFormat  YYYY-MM-DD
  axisFormat  %b %d
  section Phase 0 Foundations
  Docs + scaffold + protocol            :p0a, 2026-06-17, 4d
  CF infra + GPU adapter + health-check :p0b, after p0a, 4d
  section Phase 1 Assets
  avatar-build (reference video)        :p1a, after p0b, 6d
  voice clone + web flows               :p1b, after p0b, 6d
  section Phase 2 Offline MVP
  offline pipeline orchestrator         :p2a, after p1a, 7d
  DSL script editor + LLM-assist        :p2b, after p1b, 6d
  section Phase 3 Quality + Perf
  eval harness                          :p3a, after p2a, 5d
  inference optimization + tiers        :p3b, after p3a, 8d
  section Phase 4 Realtime
  SFU media path + session UI           :p4a, after p3b, 7d
  realtime loop + warm pool + barge-in  :p4b, after p4a, 10d
  section Phase 5 Deploy
  minimal deploy + ops notes            :p5a, after p4b, 3d
```

## Phase 0 — Foundations
Docs (`PRODUCT_SPEC`, `ARCHITECTURE`, `ROADMAP`); monorepo scaffold + tooling; `packages/protocol` (Zod DSL + job/event/director contracts); Cloudflare infra (D1 migrations, R2 buckets, KV, Queues, `SessionDO`/`JobDO`); `GpuProvider` adapter (Modal) + Queue consumer health-check. No auth.

**Exit:** `npm install && npm run typecheck` green; a health-check job dispatched from a Worker runs on the GPU provider and writes a result to R2.

## Phase 1 — Avatar + Voice assets
`avatar-build` (reference video → crop/QC → ArcFace identity → `AvatarProfile`; optional LoRA); `image-gen` fallback; `voice` clone + TTS smoke; web capture/upload flows + asset library + upload endpoints.

**Exit:** a user creates an avatar from a reference video and a cloned voice; both persist and list; fallback image-gen avatar works.

## Phase 2 — Offline generation (MVP)
DSL script editor + LLM-assist draft; `POST /jobs` → Queue; orchestrator runs TTS → talking-head → finishing → 1080p mp4 in R2; live status via `JobDO`; preview + download.

**Exit:** end-to-end offline generation yields a downloadable 1080p mp4 with cloned voice + DSL-driven gestures; status visible live.

## Phase 3 — Quality + performance
`scripts/eval` (Sync-C/D, LSE-C, ArcFace, FID/FVD, MOS); inference optimization (TensorRT/FP8, torch.compile, CUDA graphs, batching, weight caching); tiered fast/premium models.

**Exit:** premium tier passes quality thresholds and meets the offline gen-time target; results recorded in the eval report.

## Phase 4 — Realtime LLM-directed streaming
SFU media path (NVENC + WHIP/WHEP) + realtime session UI; `SessionDO` warm-pool + director-LLM loop; realtime worker (STT → LLM DSL → TTS → talking-head → light finishing); barge-in.

**Exit:** live two-way conversation; <150 ms steady-state media, ~0.8–1.5 s turn response, working barge-in, stable identity over multi-minute sessions.

## Phase 5 — Minimal deploy (internal)
Deploy scripts (`wrangler deploy` + GPU image build/push + pool start/stop); brief `SETUP.md` / `OPERATIONS.md`; VPN/port-forward demo access.

**Exit:** a teammate can deploy and reach a working demo over VPN/port-forward.

## Deferred (not in current scope)
Auth/login, multi-tenant isolation, consent capture + watermarking + moderation, billing/quotas, dashboards/alerting, public open-source packaging + license matrix.
