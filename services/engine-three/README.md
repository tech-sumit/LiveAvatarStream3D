# engine-three — Three.js render node

Headless **PerformanceManifest** renderer for LiveAvatarStream3D.

## Quick start (local)

```bash
cd services/engine-three
npm install
npm run build --workspace @las/protocol  # from repo root if needed
npm run render:local -- assets/fixtures/poc_manifest.json assets/fixtures/silence.wav ./out
```

Requires `gl` native module (Linux pod) and `ffmpeg` on PATH.

## Pod (H100 co-located)

Routed via nginx: `{GPU_PROVIDER_BASE_URL}/engine-three/render`

See `services/gpu/deploy/POD_SETUP.md` §6.

## Assets

| Path | Purpose |
|---|---|
| `assets/avatars/ada.glb` | Ready Player Me export (ARKit morphs) — placeholder used if missing |
| `assets/avatars/registry.json` | Avatar metadata |
| `assets/avatars/morph_maps/arkit_default.json` | Emotion + viseme → morph weights |
| `assets/anims/M_*.glb` | Body montage clips (optional; procedural fallback) |
| `assets/fixtures/` | POC manifest + script |

## Environment

| Var | Default | Description |
|---|---|---|
| `PORT` | 8090 | HTTP listen |
| `RENDER_PROFILE` | prod | `dev` → 1080p regardless of manifest |
| `LIPSYNC_MODE` | envelope | `viseme` (Rhubarb), `a2f` (NIM) |
| `MONTAGE_MODE` | procedural | `gltf` when montage clips present |
| `LAS_ASSETS_DIR` | `./assets` | Asset root |

Spec: `docs/specs/2026-06-19-threejs-engine-poc.md`
