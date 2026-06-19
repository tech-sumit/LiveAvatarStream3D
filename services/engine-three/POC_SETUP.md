# Three.js render node — POC setup

Runbook for offline cinematic clips via `engine_render` → `services/engine-three` on the **H100 GPU pod**.

## Prerequisites

| Item | Notes |
|---|---|
| **GPU pod** | H100 pod with NVIDIA driver + headless WebGL (`npm` package `gl`) |
| **Node.js** | 20+ (installed by `install_deps.sh` §8) |
| **ffmpeg** | On PATH |
| **R2 credentials** | Same as GPU plane |
| **Control plane** | Deployed Worker with queue consumer |
| **A2F NIM** | Optional — `A2F_NIM_URL=http://127.0.0.1:52000` |

## Environment

```bash
PORT=8090
CONTROL_API_URL=https://las-control-api.<your-subdomain>.workers.dev
INTERNAL_SERVICE_TOKEN=<same as GPU plane>

R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_OUTPUTS_BUCKET=las-outputs

RENDER_PROFILE=dev          # 1080p POC; prod for manifest 4K
LIPSYNC_MODE=envelope       # envelope | viseme | a2f
MONTAGE_MODE=procedural     # gltf when anims/*.glb present

# Optional — self-hosted Audio2Face-3D NIM
A2F_NIM_URL=http://127.0.0.1:52000

LAS_ASSETS_DIR=/opt/las/services/engine-three/assets
```

The orchestrator calls `{GPU_PROVIDER_BASE_URL}/engine-three/render` with
`Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` — no separate render-node URL secret.

## Pod bring-up

Managed by supervisord on the H100 pod. See `services/gpu/deploy/POD_SETUP.md` §6.

Manual dev:

```bash
cd /opt/las/services/engine-three
npm install
npm run build
node dist/index.js
```

Health: `curl -s localhost:8080/engine-three/health`

## Local spike (no R2)

```bash
npm run render:local -- assets/fixtures/poc_manifest.json assets/fixtures/silence.wav ./out
```

Requires `gl` (Linux pod) and `ffmpeg`. macOS can typecheck but not render headlessly.

## First end-to-end job

```http
POST /api/engine-jobs
{
  "userId": "...",
  "spec": {
    "avatarId": "ada",
    "voiceId": "...",
    "script": { ... },
    "fps": 24,
    "resolution": { "width": 3840, "height": 2160 }
  }
}
```

Flow: TTS → `manifest.json` in R2 → `POST /engine-three/render` → mp4 in R2 → job `succeeded`.

Validate: `python3 services/gpu/deploy/validate_engine_render.py`

## Avatar assets

1. Export or download a glTF/VRM with ARKit morph targets (Ready Player Me, VRoid).
2. Save as `assets/avatars/ada.glb` (`avatarId: ada` in manifest).
3. Re-run render — procedural placeholder is used automatically when the file is missing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `gl` module build fails | Run on Linux pod; `install_deps.sh` installs build deps |
| Black frames | Check `preserveDrawingBuffer`; verify GPU visible to container |
| ffmpeg not found | `apt install ffmpeg` |
| 401 on `/render` | Match `INTERNAL_SERVICE_TOKEN` on pod + control-api |

Spec: `docs/specs/2026-06-19-threejs-engine-poc.md`
