#!/usr/bin/env bash
#
# Build the isolated MuseTalk venv + download MuseTalk realtime weights.
#
# MuseTalk's deps (diffusers 0.30 / transformers 4.39 / numpy 1.23 / tensorflow
# + the OpenMMLab dwpose stack) conflict with the realtime service's system
# interpreter, so it runs in /workspace/musetalk-venv driven by
# musetalk_worker.py via MUSETALK_PYTHON. This venv is self-contained (its own
# torch 2.1.0+cu121) because mmcv has no prebuilt wheel for the system's torch
# 2.4. Idempotent: re-running skips an existing venv and existing weights.
#
# Usage (on the pod):  bash services/gpu/deploy/setup_musetalk.sh
# See deploy/POD_SETUP.md "MuseTalk venv" and deploy/requirements.pod-musetalk.txt.

set -euo pipefail

: "${WORKSPACE:=/workspace}"
: "${MUSETALK_ROOT:=${WORKSPACE}/repos/MuseTalk}"
: "${MUSETALK_VENV:=${WORKSPACE}/musetalk-venv}"
: "${HF_TOKEN:=}"

log()  { echo "[setup-musetalk] $*"; }
warn() { echo "[setup-musetalk] WARNING: $*" >&2; }

if [[ ! -d "${MUSETALK_ROOT}/.git" ]]; then
    warn "MuseTalk repo not found at ${MUSETALK_ROOT}; clone it first (seed_weights.sh does this)."
    exit 1
fi

PY="${MUSETALK_VENV}/bin/python"

# --- 1. venv + deps -----------------------------------------------------------
if [[ ! -x "${PY}" ]]; then
    log "creating venv at ${MUSETALK_VENV} (self-contained, own torch)"
    python3 -m venv "${MUSETALK_VENV}"
fi
# setuptools must stay <81: 81+ drops pkg_resources, which mmengine imports.
"${PY}" -m pip install --upgrade pip wheel "setuptools<81"

if ! "${PY}" -c "import torch" 2>/dev/null; then
    log "installing torch 2.1.0 + torchvision 0.16.0 (cu121)"
    "${PY}" -m pip install torch==2.1.0 torchvision==0.16.0 \
        --index-url https://download.pytorch.org/whl/cu121
fi

log "installing MuseTalk upstream requirements"
"${PY}" -m pip install -r "${MUSETALK_ROOT}/requirements.txt"

# dwpose stack via openmim (auto-picks the cu121/torch2.1 prebuilt mmcv wheel).
if ! "${PY}" -c "import mmpose" 2>/dev/null; then
    log "installing OpenMMLab dwpose stack (mmengine/mmcv/mmdet/mmpose)"
    "${PY}" -m pip install -U openmim
    "${PY}" -m mim install mmengine
    "${PY}" -m mim install "mmcv==2.1.0"
    "${PY}" -m mim install "mmdet==3.2.0"
    # chumpy (an mmpose 3D-SMPL dep we don't use for dwpose) ships a setup.py that
    # `import pip`s inside the isolated build env and fails; build it against the
    # venv instead. mmpose itself + matplotlib/numpy pins keep numpy at 1.23.5
    # (mmengine pulls matplotlib>=3.8 which would bump numpy to 2.x and break mmcv).
    "${PY}" -m pip install --no-build-isolation chumpy
    "${PY}" -m pip install "mmpose==1.3.1" "matplotlib==3.7.5" "numpy==1.23.5"
    # openmim/openxlab bump setuptools; keep it <81 so pkg_resources survives.
    "${PY}" -m pip install "setuptools<81"
fi

# --- 2. weights into ${MUSETALK_ROOT}/models ---------------------------------
# Use the venv's huggingface-cli with the DEFAULT endpoint (the repo's
# download_weights.sh points at hf-mirror.com which is slow/unreliable here).
cd "${MUSETALK_ROOT}"
MODELS="${MUSETALK_ROOT}/models"
mkdir -p "${MODELS}"/{musetalk,musetalkV15,syncnet,dwpose,face-parse-bisent,sd-vae,whisper}
export HF_ENDPOINT="https://huggingface.co"
if [[ -n "${HF_TOKEN}" ]]; then export HF_TOKEN HUGGING_FACE_HUB_TOKEN="${HF_TOKEN}"; fi
HFCLI="${MUSETALK_VENV}/bin/huggingface-cli"

hf_dl() {  # hf_dl <repo> <local-dir> <include...>
    # NB: huggingface-cli --include is nargs="+", so ALL patterns must follow a
    # single --include flag (repeating --include keeps only the last pattern).
    local repo="$1"; local dst="$2"; shift 2
    "${HFCLI}" download "${repo}" --local-dir "${dst}" --include "$@" || warn "download failed: ${repo}"
}

log "downloading MuseTalk v1.0 + v1.5 unet weights"
hf_dl TMElyralab/MuseTalk "${MODELS}" "musetalk/musetalk.json" "musetalk/pytorch_model.bin"
hf_dl TMElyralab/MuseTalk "${MODELS}" "musetalkV15/musetalk.json" "musetalkV15/unet.pth"
log "downloading sd-vae-ft-mse"
hf_dl stabilityai/sd-vae-ft-mse "${MODELS}/sd-vae" "config.json" "diffusion_pytorch_model.bin"
log "downloading whisper-tiny"
hf_dl openai/whisper-tiny "${MODELS}/whisper" "config.json" "pytorch_model.bin" "preprocessor_config.json"
log "downloading dwpose dw-ll_ucoco_384"
hf_dl yzd-v/DWPose "${MODELS}/dwpose" "dw-ll_ucoco_384.pth"
log "downloading syncnet (LatentSync)"
hf_dl ByteDance/LatentSync "${MODELS}/syncnet" "latentsync_syncnet.pt"

# face-parse-bisent: BiSeNet weights + resnet18 backbone. Upstream uses a Google
# Drive id via gdown (rate-limited / quota-blocked here), so prefer a HF mirror.
if [[ ! -s "${MODELS}/face-parse-bisent/79999_iter.pth" ]]; then
    log "downloading face-parse-bisent 79999_iter.pth (HF mirror)"
    curl -fsSL -o "${MODELS}/face-parse-bisent/79999_iter.pth" \
        "https://huggingface.co/ManyOtherFunctions/face-parse-bisent/resolve/main/79999_iter.pth" \
        || "${MUSETALK_VENV}/bin/gdown" --id 154JgKpzCPW82qINcVieuPH3fZ2e0P812 \
            -O "${MODELS}/face-parse-bisent/79999_iter.pth" \
        || warn "face-parse 79999_iter.pth download failed"
fi
if [[ ! -s "${MODELS}/face-parse-bisent/resnet18-5c106cde.pth" ]]; then
    curl -fsSL https://download.pytorch.org/models/resnet18-5c106cde.pth \
        -o "${MODELS}/face-parse-bisent/resnet18-5c106cde.pth" || warn "resnet18 download failed"
fi

log "done. MUSETALK_PYTHON=${PY}"
