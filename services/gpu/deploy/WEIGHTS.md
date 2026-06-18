# GPU plane model weights

Everything the six GPU services need is staged on the persistent `/workspace`
network volume by [`seed_weights.sh`](./seed_weights.sh) and pointed at by env
vars exported in [`start.sh`](./start.sh). Caches use `HF_HOME` /
`MODEL_CACHE_DIR=/workspace/.model_cache` so nothing re-downloads across pod
restarts.

## Volume layout

```
/workspace
├── .model_cache/            # HF_HOME / diffusers / torch / insightface caches
│   ├── hub/                 # HUGGINGFACE_HUB_CACHE (SDXL, XTTS, ...)
│   ├── torch/               # TORCH_HOME
│   └── insightface/         # buffalo_l
├── repos/
│   ├── echomimic_v3/        # TALKING_HEAD_ROOT (cloned)
│   │   └── models/          # EchoMimicV3 weights (repo-relative layout)
│   └── MuseTalk/            # MUSETALK_ROOT (cloned)
└── models/                  # MODELS_DIR — direct-download checkpoints
    ├── GFPGANv1.4.pth
    ├── RealESRGAN_x4plus.pth
    └── Practical-RIFE/
```

`/opt/models` is symlinked to `/workspace/models` so the finishing service's
hard-coded `/opt/models/Practical-RIFE/...` (and default GFPGAN/Real-ESRGAN
paths) resolve without editing that service.

## Manifest (source → target → env)

| Model | Source | Target path | Used by | Env var |
|---|---|---|---|---|
| Wan2.1-Fun base | `alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP` (HF) | `repos/echomimic_v3/models/Wan2.1-Fun-V1.1-1.3B-InP` | avatar-video | `ECHOMIMIC_WAN_DIR` |
| EchoMimicV3 preview transformer | `BadToBest/EchoMimicV3` → `transformer/` (HF) | `repos/echomimic_v3/models/transformer/diffusion_pytorch_model.safetensors` | avatar-video (premium) | `ECHOMIMIC_PREVIEW_TRANSFORMER` |
| EchoMimicV3 flash transformer | `BadToBest/EchoMimicV3` → `echomimicv3-flash-pro/` (HF) | `repos/echomimic_v3/models/echomimicv3-flash-pro/diffusion_pytorch_model.safetensors` | avatar-video (fast) | `ECHOMIMIC_FLASH_TRANSFORMER` |
| wav2vec2 (preview audio enc.) | `facebook/wav2vec2-base-960h` (HF) | `repos/echomimic_v3/models/wav2vec2-base-960h` | avatar-video (premium) | `ECHOMIMIC_PREVIEW_WAV2VEC` |
| chinese-wav2vec2 (flash audio enc.) | `TencentGameMate/chinese-wav2vec2-base` (HF) | `repos/echomimic_v3/models/chinese-wav2vec2-base` | avatar-video (fast) | `ECHOMIMIC_FLASH_WAV2VEC` |
| MuseTalk | `TMElyralab/MuseTalk` repo downloader | `repos/MuseTalk/models/...` | realtime (Phase 4) | `MUSETALK_ROOT` |
| GFPGAN v1.4 | TencentARC GFPGAN release | `models/GFPGANv1.4.pth` | finishing | `GFPGAN_MODEL` |
| Real-ESRGAN x4plus | xinntao Real-ESRGAN release | `models/RealESRGAN_x4plus.pth` | finishing | `REALESRGAN_MODEL` |
| Practical-RIFE | `hzwer/Practical-RIFE` repo | `models/Practical-RIFE/` (→ `/opt/models/Practical-RIFE`) | finishing | (hard-coded path) |
| SDXL base | `stabilityai/stable-diffusion-xl-base-1.0` (HF) | `${HF_HOME}` cache | image-gen | `IMAGE_GEN_MODEL` |
| Coqui XTTS-v2 | `tts_models/multilingual/multi-dataset/xtts_v2` | `${HF_HOME}` / TTS cache | voice | `COQUI_TOS_AGREED=1` |
| insightface buffalo_l | insightface model zoo | `${INSIGHTFACE_HOME}` | avatar-build | `INSIGHTFACE_HOME` |

## EchoMimicV3 repo-relative paths

`avatar-video/models.py` defaults `ECHOMIMIC_WEIGHTS_DIR` to
`${TALKING_HEAD_ROOT}/models`, matching the upstream repo's own `models/` layout
so both `infer_flash.py` (fast) and the vendored `echomimic_preview_infer.py`
(premium) find weights without extra config. Override any individual path with
the env vars above if you stage weights elsewhere.

## Auth / gating

- `HF_TOKEN` (passthrough from pod env) is exported as `HUGGING_FACE_HUB_TOKEN`
  for any gated repos. `Wan2.1-Fun` and the EchoMimicV3 weights are public, but a
  token avoids rate limits on large pulls.
- `COQUI_TOS_AGREED=1` is required to download XTTS-v2 non-interactively.

## First boot

`start.sh` runs `seed_weights.sh` automatically when the flash transformer
sentinel is missing. Force a re-seed with `SEED_WEIGHTS=1`, skip it with
`SEED_WEIGHTS=0`. Expect a large first-boot download (tens of GB); subsequent
boots are no-ops because everything lives on the volume.
