# LiveAvatarStream3D — Specs index

Design and status docs for this repo. **Convention: when older specs disagree, the newest
wins** (see `CLAUDE.md`). The repo was consolidated on **2026-06-26** to a browser-only 3D
talking-avatar studio — the headless `engine-three` renderer was removed and the 2D
(EchoMimicV3) + MuseTalk realtime paths moved to `../LiveAvatarStream` — so everything from
the engine-three / H100-pod era below is historical.

## Active

| Document | What it covers |
|---|---|
| [2026-06-25-performance-score-dsl-design.md](./2026-06-25-performance-score-dsl-design.md) | **Start here** — the approved redesign: a parameterized, spatial, compositional Score/Stage performance model run by one shared interpreter (direction as data, not code) |
| [2026-06-25-webmcp-studio-control-design.md](./2026-06-25-webmcp-studio-control-design.md) | In-browser WebMCP server (v1 implemented): the studio's bridge tools on `navigator.modelContext` so any AI app can drive it live |
| [2026-06-27-newscast-authoring-guide.md](./2026-06-27-newscast-authoring-guide.md) | How to author a `NewsReportDoc` that renders naturally: anchor framing, choreography, video-wall slide deck (mechanism-level, with file refs) |
| [2026-06-27-webmcp-claude-code-integration.md](./2026-06-27-webmcp-claude-code-integration.md) | Operational recipe for driving the studio's WebMCP tools from Claude Code via `chrome-devtools-mcp` (recommended) or `@tech-sumit/mcp-webmcp` |
| [2026-06-29-camera-shot-preset-catalog-design.md](./2026-06-29-camera-shot-preset-catalog-design.md) | Data-driven camera shot-preset catalog (10 framings) replacing the hardcoded close/medium/wide shots — shipped in PR #63 |
| [2026-07-03-newscast-path-unification-design.md](./2026-07-03-newscast-path-unification-design.md) | Newscast compile-path unification (system-review round 2): fixes the lossy `apply_newscast` path, the triple-clock mismatch, and shot-preset drop — PR #65 |
| [plans/2026-06-26-score-dsl-implementation-plan.md](./plans/2026-06-26-score-dsl-implementation-plan.md) | Phased implementation plan for the Score DSL design (Phase 5 authoring/emission cut-over landed — see `progress.md`) |

## Historical (pre-consolidation / superseded)

| Document | What it covered |
|---|---|
| [2026-06-20-project-context.md](./2026-06-20-project-context.md) | Goals, architecture, branches, infra, validation history of the engine-three + H100-pod era — **superseded** by `CLAUDE.md` + the active specs |
| [2026-06-20-how-to-run.md](./2026-06-20-how-to-run.md) | Commands for the editor / pod lifecycle / validators — **superseded**; most commands no longer exist (current: `npm run dev:avatar`) |
| [2026-06-20-scene-editor-threejs.md](./2026-06-20-scene-editor-threejs.md) | three.js scene editor + LAS Render tab — **superseded**; the scene editor was dropped in the consolidation |
| [2026-06-20-next-steps.md](./2026-06-20-next-steps.md) | Prioritized backlog of the pod/WYSIWYG era (incl. realtime Phase 4) — **superseded** |
| [2026-06-20-realtime-avatar-live.md](./2026-06-20-realtime-avatar-live.md) | The founding decision for browser-side 3D rendering (`apps/avatar-live` v1) — the origin of the current studio; details superseded by the Score DSL design |
| [2026-06-21-avatar-live-main-modularization.md](./2026-06-21-avatar-live-main-modularization.md) | Spec: refactor `main.ts` into class-based controllers — **completed** |
| [2026-06-21-avatar-live-main-modularization-plan.md](./2026-06-21-avatar-live-main-modularization-plan.md) | Task-by-task plan for the modularization — **completed** |
| [2026-06-21-newscast-dsl-design.md](./2026-06-21-newscast-dsl-design.md) | The `NewsReportDoc` v2 contract + compiler design; the doc shape lives on in `@las/protocol`, but direction authoring is **superseded** by the Score/Stage model (NewsReportDocs are auto-lowered to Scores) |
| [2026-06-21-newscast-dsl-sp1-mp4-export-plan.md](./2026-06-21-newscast-dsl-sp1-mp4-export-plan.md) | SP-1: frame-exact client-side MP4/4K export (WebCodecs + Mediabunny) — **shipped** |
| [2026-06-21-newscast-dsl-sp2-camera-filters-plan.md](./2026-06-21-newscast-dsl-sp2-camera-filters-plan.md) | SP-2: post-processing "look" system (pmndrs postprocessing) in viewport + export — **shipped** |
| [2026-06-21-newscast-dsl-sp3-language-plan.md](./2026-06-21-newscast-dsl-sp3-language-plan.md) | SP-3: `NewsReportDoc` → editor import/compile language MVP — **shipped** |
| [2026-06-23-avatar-live-ui-improvement-plan.md](./2026-06-23-avatar-live-ui-improvement-plan.md) | Studio UI improvement plan (control-room polish, P0–P2) |
| [2026-06-24-newsroom-mcp-design.md](./2026-06-24-newsroom-mcp-design.md) | stdio Newsroom MCP driving the studio over the WS bridge — being **superseded** by the in-browser WebMCP server (2026-06-25 design) |

## Related (outside `specs/`)

| Path | Role |
|---|---|
| `progress.md` | Dated status log — GPU-plane validation history (historical) + the 2026-06/07 studio milestones |
| `docs/scene-editor-architecture.md` | Original React-editor architecture — **superseded**, scene editor removed |
| `services/gpu/deploy/POD_SETUP.md` | GPU pod bring-up for the remaining control-plane services (voice / avatar-build / image-gen) |

## Quick start

```bash
cd projects/LiveAvatarStream3D
npm install                 # also rebuilds @las/performer-core's gitignored dist/
npm run dev:avatar          # the studio → http://localhost:5175
npm run typecheck && npm test
```

Studio API target: `apps/avatar-live/.env.development` → deployed Worker
(`VITE_API_URL`) — cloned voices live on the deployed D1/R2, not local wrangler dev.
