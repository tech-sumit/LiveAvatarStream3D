# Next steps — prioritized backlog

**Date:** 2026-06-20  
**Context:** [project-context](./2026-06-20-project-context.md) · [how-to-run](./2026-06-20-how-to-run.md)

---

## P0 — Unblock WYSIWYG renders (do first)

These were identified in the Jun 19–20 debugging session: editor manifests are correct; pod was running stale `engine-three`.

| # | Task | Command / owner |
|---|---|---|
| 1 | **Commit** three.js editor migration + LAS layer on `main` | git |
| 2 | **Deploy** control-api (`DELETE /api/voices`, manifest prefix fix if not already live) | `wrangler deploy` |
| 3 | **Sync** engine-three to pod | `POD_SSH=root@<pod-ip> POD_SSH_PORT=<port> ./scripts/gpu/sync-engine-three.sh` |
| 4 | **Verify** pod health | `curl …/engine-three/health` → `wysiwygScene: true`, `leePerrySmithLoaded: true` |
| 5 | **Re-record** from editor; confirm MP4 matches viewport (Lee bust + camera rotation) | manual |
| 6 | **Remove** debug instrumentation in `render.ts` / old React files if any remain on main | code cleanup |

### Acceptance criteria (P0)

- [ ] Editor Record → succeeded job → MP4 shows Lee Perry-Smith (or empty scene if camera turned away), not procedural stick figure
- [ ] Manifest `scene.nodes` camera rotation matches editor orbit at record time
- [ ] Health endpoint reports WYSIWYG flags

---

## P1 — Scene editor completeness

| # | Task | Notes |
|---|---|---|
| 7 | Voice clone UI in editor | Port `VoicePanel` / `MediaRecorderBox` from `backup/custom-scene-editor` into LAS tab or menubar |
| 8 | R2 scene CRUD | `GET/POST/PUT /api/scenes` + save/load in editor |
| 9 | Tag imported GLBs | Inspector fields: `lasAvatarId`, `lasLightType`, prop `assetKey` |
| 10 | `POST /preview` on pod | Single authoritative PNG; "Preview on GPU" button |
| 11 | Host editor on Cloudflare Pages | `npm run build --workspace apps/scene-editor` |

---

## P2 — Render quality & assets

| # | Task | Notes |
|---|---|---|
| 12 | Ship `ada.glb` to editor `public/avatars/` | ~28MB; matches pod production avatar |
| 13 | Camera keyframe timeline | Beats → `PerformanceManifest.camera[]` |
| 14 | A2F NIM sidecar on pod | When VRAM allows; better lip-sync than decal/viseme |
| 15 | 4K render path | POC spec target 3840×2160; currently 1920×1080 default |

---

## P3 — Realtime (existing Phase 4)

Gated on Cloudflare Realtime secrets. See `progress.md` and [project-context](./2026-06-20-project-context.md).

| # | Task |
|---|---|
| 16 | Set `CF_REALTIME_APP_SECRET`, `CF_TURN_KEY_API_TOKEN` |
| 17 | Validate MuseTalk on pod (`validate_musetalk.py`) |
| 18 | Browser live session via existing `POST /api/sessions` |
| 19 | Editor "Go Live" → bridge to SFU + MuseTalk |

---

## P4 — Ops & cost

| # | Task |
|---|---|
| 20 | **Stop pod** when not actively rendering (`spawn-pod.sh` / RunPod API) |
| 21 | Push `main` to `origin` (currently only initial commit on remote) |
| 22 | Document pod rotation in `wrangler.toml` when pod ID changes |

---

## Open blockers log

| Blocker | Status | Resolution |
|---|---|---|
| Pod sync interrupted | **Open** | Re-run `sync-engine-three.sh`; verify supervisord restart |
| `supervisorctl restart engine-three` failed (port 9001 refused) | **Open** | SSH manual restart via `start.sh` |
| DELETE voice API not on deployed Worker | **Open** | Deploy control-api |
| Local `main` uncommitted + unpushed | **Open** | Commit + push when ready |
| Debug logs in engine-three `render.ts` | **Open** | Remove after P0 verification |

---

## What NOT to do

- Do not raise Playwright-style retries on recording jobs — failures should surface loudly
- Do not point editor at local wrangler dev for voice clone (isolated D1/R2 → "sample not found" on GPU)
- Do not relocate `demo-recorder/` without its `qa-portal/` sibling (AIDemoRecorder repo rule — unrelated but noted if cross-repo)

---

## Session handoff checklist

When picking this up again:

1. Read [README.md](./README.md) in this folder
2. `./scripts/gpu/spawn-pod.sh --info` — is pod running?
3. `./scripts/gpu/health-roundtrip.sh --direct`
4. `npm run dev:editor` → http://localhost:5174
5. If renders wrong → sync engine-three (P0 #3–4)
6. Check `progress.md` for latest validation dates
