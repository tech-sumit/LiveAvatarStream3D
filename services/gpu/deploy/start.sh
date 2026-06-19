#!/usr/bin/env bash
#
# LiveAvatarStream GPU pod entrypoint.
#
# Exports the runtime env contract every service expects, optionally seeds model
# weights onto the persistent /workspace volume (only if missing), then hands off
# to supervisord which runs the six uvicorns + nginx gateway on :8080.
#
# Idempotent: safe to re-run. Re-running with weights already present is a no-op
# for the (slow) download step. Configure via the pod's environment; everything
# below uses ${VAR:=default} so explicit pod env always wins.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
GPU_DIR="${REPO_ROOT}/services/gpu"

# --- Persistent volume layout -------------------------------------------------
: "${WORKSPACE:=/workspace}"
: "${MODEL_CACHE_DIR:=${WORKSPACE}/.model_cache}"
: "${HF_HOME:=${MODEL_CACHE_DIR}}"
: "${HUGGINGFACE_HUB_CACHE:=${HF_HOME}/hub}"
: "${TORCH_HOME:=${MODEL_CACHE_DIR}/torch}"
: "${INSIGHTFACE_HOME:=${MODEL_CACHE_DIR}/insightface}"
: "${TALKING_HEAD_ROOT:=${WORKSPACE}/repos/echomimic_v3}"
: "${MUSETALK_ROOT:=${WORKSPACE}/repos/MuseTalk}"
: "${MODELS_DIR:=${WORKSPACE}/models}"

# --- Finishing chain model paths (services/gpu/finishing/pipeline.py) ----------
: "${GFPGAN_MODEL:=${MODELS_DIR}/GFPGANv1.4.pth}"
: "${REALESRGAN_MODEL:=${MODELS_DIR}/RealESRGAN_x4plus.pth}"
# Practical-RIFE checkout (weights live in train_log/); /opt/models symlinks the volume.
: "${RIFE_DIR:=${MODELS_DIR}/Practical-RIFE}"
: "${RIFE_PYTHON:=python3}"

# --- Inter-service wiring ------------------------------------------------------
# avatar-build calls the image-gen service for the "generated" avatar path.
: "${IMAGE_GEN_URL:=http://127.0.0.1:8002}"

# EchoMimicV3 inference runs in an isolated venv (torch-2.4-compatible diffusers
# /transformers, kept apart from the voice service's coqui-tts). avatar-video
# shells out to this interpreter; falls back to system python3 if unset.
: "${ECHOMIMIC_PYTHON:=/workspace/echomimic-venv/bin/python}"

# MuseTalk realtime lip-sync runs in its own self-contained venv (own torch 2.1
# + cu121 + the OpenMMLab dwpose stack, incompatible with system torch 2.4). The
# realtime service shells out to this interpreter via musetalk_worker.py. Build
# it once with deploy/setup_musetalk.sh.
: "${MUSETALK_PYTHON:=/workspace/musetalk-venv/bin/python}"
: "${MUSETALK_VERSION:=v15}"
: "${MUSETALK_AVATAR_CACHE:=${WORKSPACE}/musetalk-avatars}"

# --- R2 / control-plane (passthrough from pod env; bucket defaults provided) ---
: "${R2_ASSETS_BUCKET:=las-assets}"
: "${R2_AVATARS_BUCKET:=las-avatars}"
: "${R2_VOICES_BUCKET:=las-voices}"
: "${R2_OUTPUTS_BUCKET:=las-outputs}"
: "${R2_ACCOUNT_ID:=}"
: "${R2_ACCESS_KEY_ID:=}"
: "${R2_SECRET_ACCESS_KEY:=}"
: "${R2_ENDPOINT:=}"
: "${CONTROL_API_URL:=http://localhost:8787}"
: "${INTERNAL_SERVICE_TOKEN:=change-me}"
: "${ENGINE_THREE_DIR:=${REPO_ROOT}/services/engine-three}"
: "${RENDER_PROFILE:=dev}"
: "${LIPSYNC_MODE:=envelope}"
: "${MONTAGE_MODE:=procedural}"
: "${HF_TOKEN:=}"
: "${COQUI_TOS_AGREED:=1}"

# las_common must be importable from each service's working directory.
PYTHONPATH="${GPU_DIR}/common${PYTHONPATH:+:${PYTHONPATH}}"

export WORKSPACE MODEL_CACHE_DIR HF_HOME HUGGINGFACE_HUB_CACHE TORCH_HOME \
    INSIGHTFACE_HOME TALKING_HEAD_ROOT MUSETALK_ROOT MODELS_DIR \
    GFPGAN_MODEL REALESRGAN_MODEL RIFE_DIR RIFE_PYTHON IMAGE_GEN_URL ECHOMIMIC_PYTHON \
    MUSETALK_PYTHON MUSETALK_VERSION MUSETALK_AVATAR_CACHE \
    R2_ASSETS_BUCKET R2_AVATARS_BUCKET R2_VOICES_BUCKET R2_OUTPUTS_BUCKET \
    R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT \
    CONTROL_API_URL INTERNAL_SERVICE_TOKEN HF_TOKEN COQUI_TOS_AGREED \
    ENGINE_THREE_DIR RENDER_PROFILE LIPSYNC_MODE MONTAGE_MODE \
    GPU_DIR REPO_ROOT PYTHONPATH

mkdir -p "${MODEL_CACHE_DIR}" "${HUGGINGFACE_HUB_CACHE}" "${MODELS_DIR}" \
    "${WORKSPACE}/repos" "${INSIGHTFACE_HOME}"

# insightface hard-codes ~/.insightface and ignores INSIGHTFACE_HOME, so buffalo_l
# lands on the ephemeral container disk and re-downloads on every pod restart.
# Symlink ~/.insightface onto the persistent volume so the model pack survives.
INSIGHTFACE_LINK="${HOME:-/root}/.insightface"
if [[ ! -L "${INSIGHTFACE_LINK}" ]]; then
    if [[ -d "${INSIGHTFACE_LINK}" ]]; then
        cp -an "${INSIGHTFACE_LINK}/." "${INSIGHTFACE_HOME}/" 2>/dev/null || true
        rm -rf "${INSIGHTFACE_LINK}"
    fi
    ln -sfn "${INSIGHTFACE_HOME}" "${INSIGHTFACE_LINK}" \
        || echo "[start] WARNING: could not symlink ${INSIGHTFACE_LINK} -> ${INSIGHTFACE_HOME}" >&2
fi

# --- Weight seeding (idempotent, skippable) -----------------------------------
# Treat the EchoMimicV3 flash transformer as the canonical "weights present"
# sentinel; if it's missing, run the seeder (unless SEED_WEIGHTS=0).
ECHOMIMIC_SENTINEL="${TALKING_HEAD_ROOT}/models/echomimicv3-flash-pro/diffusion_pytorch_model.safetensors"
if [[ "${SEED_WEIGHTS:-auto}" != "0" ]]; then
    if [[ "${SEED_WEIGHTS:-auto}" == "1" || ! -f "${ECHOMIMIC_SENTINEL}" ]]; then
        if [[ -x "${SCRIPT_DIR}/seed_weights.sh" || -f "${SCRIPT_DIR}/seed_weights.sh" ]]; then
            echo "[start] Seeding model weights onto ${WORKSPACE} (this is slow on first boot)..."
            bash "${SCRIPT_DIR}/seed_weights.sh"
        else
            echo "[start] WARNING: weights missing and seed_weights.sh not found; services may fail to load models." >&2
        fi
    else
        echo "[start] Weights present (${ECHOMIMIC_SENTINEL}); skipping seed."
    fi
else
    echo "[start] SEED_WEIGHTS=0; skipping weight seed."
fi

echo "[start] Launching GPU plane (gateway on :8080) via supervisord..."
exec supervisord -c "${GPU_DIR}/deploy/supervisord.conf"
