#!/usr/bin/env bash
#
# Seed every model the GPU plane needs onto the persistent /workspace volume.
#
# Idempotent: clones are skipped if present, HF downloads resume / no-op when the
# target already exists, and direct files use `wget -nc`. Honors HF_TOKEN for
# gated repos. Designed to run once on a fresh network volume (Phase 2) and be
# safe to re-run.
#
# Everything lands under ${WORKSPACE} so it persists across pod restarts:
#   repos   -> ${WORKSPACE}/repos/{echomimic_v3,MuseTalk}
#   models  -> ${WORKSPACE}/models                (direct-download checkpoints)
#   echomimic weights -> ${TALKING_HEAD_ROOT}/models   (repo-relative layout)
#   HF/diffusers cache -> ${HF_HOME}              (SDXL, XTTS, insightface, ...)
#
# See WEIGHTS.md for the model -> path -> env-var manifest.

set -euo pipefail

: "${WORKSPACE:=/workspace}"
: "${MODEL_CACHE_DIR:=${WORKSPACE}/.model_cache}"
: "${HF_HOME:=${MODEL_CACHE_DIR}}"
: "${HUGGINGFACE_HUB_CACHE:=${HF_HOME}/hub}"
: "${TORCH_HOME:=${MODEL_CACHE_DIR}/torch}"
: "${INSIGHTFACE_HOME:=${MODEL_CACHE_DIR}/insightface}"
: "${TALKING_HEAD_ROOT:=${WORKSPACE}/repos/echomimic_v3}"
: "${MUSETALK_ROOT:=${WORKSPACE}/repos/MuseTalk}"
: "${MODELS_DIR:=${WORKSPACE}/models}"
: "${COQUI_TOS_AGREED:=1}"
: "${HF_TOKEN:=}"

export HF_HOME HUGGINGFACE_HUB_CACHE TORCH_HOME INSIGHTFACE_HOME COQUI_TOS_AGREED
if [[ -n "${HF_TOKEN}" ]]; then
    export HF_TOKEN HUGGING_FACE_HUB_TOKEN="${HF_TOKEN}"
fi

ECHOMIMIC_MODELS="${TALKING_HEAD_ROOT}/models"
REPOS_DIR="${WORKSPACE}/repos"
mkdir -p "${REPOS_DIR}" "${MODELS_DIR}" "${ECHOMIMIC_MODELS}" \
    "${HUGGINGFACE_HUB_CACHE}" "${INSIGHTFACE_HOME}"

# insightface reads ~/.insightface (ignores INSIGHTFACE_HOME); symlink it onto the
# volume so the buffalo_l prefetch below persists and is reused across restarts.
INSIGHTFACE_LINK="${HOME:-/root}/.insightface"
if [[ ! -L "${INSIGHTFACE_LINK}" ]]; then
    if [[ -d "${INSIGHTFACE_LINK}" ]]; then
        cp -an "${INSIGHTFACE_LINK}/." "${INSIGHTFACE_HOME}/" 2>/dev/null || true
        rm -rf "${INSIGHTFACE_LINK}"
    fi
    ln -sfn "${INSIGHTFACE_HOME}" "${INSIGHTFACE_LINK}" || true
fi

log()  { echo "[seed] $*"; }
warn() { echo "[seed] WARNING: $*" >&2; }

# Pick whichever HF CLI is installed (`hf` is the new name, `huggingface-cli` old).
if command -v hf >/dev/null 2>&1; then
    HF_CLI="hf"
elif command -v huggingface-cli >/dev/null 2>&1; then
    HF_CLI="huggingface-cli"
else
    HF_CLI=""
    warn "no huggingface CLI found; HF downloads will be skipped (install 'huggingface_hub[cli]')"
fi

# hf_get <repo_id> <local_dir> [include_glob ...]
hf_get() {
    local repo="$1"; local dst="$2"; shift 2
    if [[ -z "${HF_CLI}" ]]; then
        warn "skip ${repo} (no HF CLI)"
        return 0
    fi
    local includes=()
    local g
    for g in "$@"; do
        includes+=(--include "${g}")
    done
    mkdir -p "${dst}"
    log "downloading ${repo} -> ${dst}"
    "${HF_CLI}" download "${repo}" --local-dir "${dst}" "${includes[@]}" || warn "download failed for ${repo}"
}

clone() {
    local url="$1"; local dst="$2"
    if [[ -d "${dst}/.git" ]]; then
        log "repo present: ${dst}"
    else
        log "cloning ${url} -> ${dst}"
        git clone --depth 1 "${url}" "${dst}" || warn "clone failed: ${url}"
    fi
}

# -----------------------------------------------------------------------------
# 1) Upstream repos
# -----------------------------------------------------------------------------
clone "https://github.com/antgroup/echomimic_v3.git" "${TALKING_HEAD_ROOT}"
clone "https://github.com/TMElyralab/MuseTalk.git" "${MUSETALK_ROOT}"

# -----------------------------------------------------------------------------
# 2) EchoMimicV3 weights (preview + flash) into the repo-relative models/ dir
#    Layout consumed by avatar-video/models.py + echomimic_preview_infer.py:
#      models/Wan2.1-Fun-V1.1-1.3B-InP
#      models/wav2vec2-base-960h            (preview audio encoder)
#      models/chinese-wav2vec2-base         (flash audio encoder)
#      models/transformer/...               (preview transformer)
#      models/echomimicv3-flash-pro/transformer/...   (flash transformer)
# -----------------------------------------------------------------------------
hf_get "alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP" "${ECHOMIMIC_MODELS}/Wan2.1-Fun-V1.1-1.3B-InP"
hf_get "facebook/wav2vec2-base-960h" "${ECHOMIMIC_MODELS}/wav2vec2-base-960h"
hf_get "TencentGameMate/chinese-wav2vec2-base" "${ECHOMIMIC_MODELS}/chinese-wav2vec2-base"
# EchoMimicV3 ships preview (transformer/) and flash (echomimicv3-flash-pro/) in
# one repo; pull the whole thing into models/ so both sub-paths resolve.
hf_get "BadToBest/EchoMimicV3" "${ECHOMIMIC_MODELS}"

# -----------------------------------------------------------------------------
# 3) MuseTalk weights (realtime path). Prefer the repo's own downloader.
# -----------------------------------------------------------------------------
if [[ -d "${MUSETALK_ROOT}" ]]; then
    MUSE_DL=""
    for cand in "download_weights.sh" "scripts/download_weights.sh" "download_model.sh"; do
        if [[ -f "${MUSETALK_ROOT}/${cand}" ]]; then
            MUSE_DL="${cand}"
            break
        fi
    done
    if [[ -n "${MUSE_DL}" ]]; then
        log "running MuseTalk weight downloader (${MUSE_DL})"
        ( cd "${MUSETALK_ROOT}" && bash "${MUSE_DL}" ) || warn "MuseTalk downloader failed"
    else
        warn "no MuseTalk download script found; pulling core weights via HF as a fallback"
        hf_get "TMElyralab/MuseTalk" "${MUSETALK_ROOT}/models"
    fi
fi

# -----------------------------------------------------------------------------
# 4) Finishing chain: GFPGAN + Real-ESRGAN + Practical-RIFE into ${MODELS_DIR}
#    (services/gpu/finishing reads GFPGAN_MODEL / REALESRGAN_MODEL envs, and
#     shells out to /opt/models/Practical-RIFE/inference_img.py)
# -----------------------------------------------------------------------------
wget -nc -O "${MODELS_DIR}/GFPGANv1.4.pth" \
    "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.4/GFPGANv1.4.pth" \
    || warn "GFPGAN download failed"
wget -nc -O "${MODELS_DIR}/RealESRGAN_x4plus.pth" \
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth" \
    || warn "Real-ESRGAN download failed"
clone "https://github.com/hzwer/Practical-RIFE.git" "${MODELS_DIR}/Practical-RIFE"

# Practical-RIFE ships no weights in git; fetch the v4.25 train_log (flownet.pkl +
# model .py) from Google Drive into ${MODELS_DIR}/Practical-RIFE/train_log so the
# finishing chain's RIFE interpolation can actually run (else it falls back to
# ffmpeg minterpolate).
RIFE_TRAIN_LOG="${MODELS_DIR}/Practical-RIFE/train_log"
if [[ ! -f "${RIFE_TRAIN_LOG}/flownet.pkl" ]]; then
    log "downloading Practical-RIFE v4.25 weights -> ${RIFE_TRAIN_LOG}"
    RIFE_TMP="${MODELS_DIR}/.rife_dl"
    mkdir -p "${RIFE_TMP}"
    if python3 -m gdown "1ZKjcbmt1hypiFprJPIKW0Tt0lr_2i7bg" -O "${RIFE_TMP}/rife.zip" 2>/dev/null; then
        python3 -c "import zipfile,sys; zipfile.ZipFile('${RIFE_TMP}/rife.zip').extractall('${RIFE_TMP}')" \
            && cp -r "${RIFE_TMP}/train_log" "${MODELS_DIR}/Practical-RIFE/" \
            || warn "RIFE weights extract failed"
    else
        warn "RIFE weights download failed (gdown); RIFE will fall back to minterpolate"
    fi
    rm -rf "${RIFE_TMP}"
fi

# finishing/pipeline.py hard-codes /opt/models/Practical-RIFE (and default GFPGAN
# / Real-ESRGAN paths). Symlink /opt/models -> the volume so those resolve too,
# without editing the (already-real) finishing service.
if [[ ! -e /opt/models ]]; then
    ln -sfn "${MODELS_DIR}" /opt/models || warn "could not symlink /opt/models -> ${MODELS_DIR}"
fi

# -----------------------------------------------------------------------------
# 5) Prefetches into the HF / diffusers / framework caches (best-effort).
#    These need the runtime libs installed; warn (don't fail) if absent.
# -----------------------------------------------------------------------------
: "${IMAGE_GEN_MODEL:=stabilityai/stable-diffusion-xl-base-1.0}"
log "prefetching SDXL (${IMAGE_GEN_MODEL}) into ${HF_HOME}"
python3 - "$IMAGE_GEN_MODEL" <<'PY' || warn "SDXL prefetch skipped"
import sys
from diffusers import AutoPipelineForText2Image
import torch
model = sys.argv[1]
AutoPipelineForText2Image.from_pretrained(model, torch_dtype=torch.float16, variant="fp16")
print("SDXL cached")
PY

log "prefetching Coqui XTTS-v2 (TOS agreed=${COQUI_TOS_AGREED})"
python3 - <<'PY' || warn "XTTS prefetch skipped"
import os
os.environ.setdefault("COQUI_TOS_AGREED", "1")
from TTS.utils.manage import ModelManager
ModelManager().download_model("tts_models/multilingual/multi-dataset/xtts_v2")
print("XTTS-v2 cached")
PY

log "prefetching insightface buffalo_l into ${INSIGHTFACE_HOME}"
python3 - <<'PY' || warn "insightface prefetch skipped"
from insightface.app import FaceAnalysis
app = FaceAnalysis(name="buffalo_l")
app.prepare(ctx_id=-1, det_size=(640, 640))
print("buffalo_l cached")
PY

log "done. Weights staged on ${WORKSPACE}."
