# LiveAvatarStream3D — Specs index

Authoritative planning and status docs for this repo. When a spec disagrees with
`progress.md` on **scene-editor / WYSIWYG render** topics, **these specs win**
(Jun 20, 2026 update).

| Document | What it covers |
|---|---|
| [2026-06-20-project-context.md](./2026-06-20-project-context.md) | **Start here** — goals, architecture, git branches, infra, validation history |
| [2026-06-20-how-to-run.md](./2026-06-20-how-to-run.md) | Commands: editor, API deploy, pod lifecycle, sync, validators |
| [2026-06-20-scene-editor-threejs.md](./2026-06-20-scene-editor-threejs.md) | three.js editor integration, LAS Render tab, export bridge, voice dedupe |
| [2026-06-20-next-steps.md](./2026-06-20-next-steps.md) | Prioritized backlog and open blockers (includes realtime Phase 4) |

Historical engine/realtime design detail is consolidated into `2026-06-20-project-context.md`.

## Related (outside `specs/`)

| Path | Role |
|---|---|
| `progress.md` | GPU-plane validation log (offline Urwashi, health round-trip, engine_render PASS Jun 19) |
| `docs/scene-editor-architecture.md` | Original React-editor architecture — **superseded** by `2026-06-20-scene-editor-threejs.md` |
| `services/engine-three/POC_SETUP.md` | Pod-side engine-three env vars and health |
| `services/gpu/deploy/POD_SETUP.md` | Full H100 pod bring-up |
| `backup/custom-scene-editor` (git branch) | Preserved custom React + Vite scene editor before three.js migration |

## Quick start

```bash
cd projects/LiveAvatarStream3D
npm install
npm run dev:editor          # http://localhost:5174 — three.js editor + Render tab
```

Editor API target: `apps/scene-editor/.env.development` → deployed Worker
(`VITE_API_URL=https://las-control-api.tech-sumit.workers.dev/api`).
