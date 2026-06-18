#!/usr/bin/env bash
#
# install_deps.sh — make a fresh RunPod H100 pod able to import + run the
# LiveAvatarStream GPU plane, reproducibly, from the repo alone.
#
# This is the package/interpreter-layout half of pod bring-up (the application
# code + weights are owned by start.sh + seed_weights.sh + setup_musetalk.sh).
# It encodes everything POD_SETUP.md describes as a "pod-only fix" so a clean
# pod needs only:  clone -> install_deps.sh -> seed_weights.sh -> start.sh
# (plus setup_musetalk.sh for the realtime lip-sync path).
#
# What it does (all idempotent — safe to re-run):
#   1. system packages: ffmpeg, nginx (apt, best-effort)
#   2. system interpreter: each service's requirements.txt (minus avatar-video's
#      heavy EchoMimicV3 block, which gets its own venv), + supervisor + the
#      coqui-tts-compatible transformers/diffusers/accelerate/ml_dtypes pins
#   3. editable install of las_common
#   4. the isolated EchoMimicV3 venv (/workspace/echomimic-venv, system-site-
#      packages) with the torch-2.4-compatible diffusers/transformers/accelerate
#      and the ml_dtypes==0.5.4 pin (onnx float4_e2m1fn)
#   5. the torchvision functional_tensor shim + basicsr patch (finishing service)
#   6. sk-video + its numpy>=1.24 patch (Practical-RIFE dep)
#
# The MuseTalk realtime venv is built separately (its own torch) by
# setup_musetalk.sh and needs the MuseTalk repo cloned first (seed_weights.sh).
# Pass SETUP_MUSETALK=1 to chain it here once the repo is present.
#
# Pinned manifests this mirrors live alongside:
#   requirements.pod-system.txt    (system interpreter)
#   requirements.pod-echomimic.txt (echomimic venv)
#   requirements.pod-musetalk.txt  (musetalk venv)
#
# Usage (on the pod):  bash services/gpu/deploy/install_deps.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
GPU_DIR="${REPO_ROOT}/services/gpu"

: "${WORKSPACE:=/workspace}"
: "${ECHOMIMIC_VENV:=${WORKSPACE}/echomimic-venv}"
: "${PY:=python3}"

log()  { echo "[install-deps] $*"; }
warn() { echo "[install-deps] WARNING: $*" >&2; }

pip_sys() { "${PY}" -m pip install "$@"; }

# -----------------------------------------------------------------------------
# 1) System packages (best-effort; the pod base image usually has most of these)
# -----------------------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
    log "ensuring system packages (ffmpeg, nginx)"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >/dev/null 2>&1 || warn "apt-get update failed (continuing)"
    apt-get install -y --no-install-recommends ffmpeg nginx >/dev/null 2>&1 \
        || warn "apt-get install ffmpeg/nginx failed (continuing)"
else
    warn "apt-get not found; ensure ffmpeg + nginx are installed by other means"
fi

# -----------------------------------------------------------------------------
# 2) System interpreter Python deps
# -----------------------------------------------------------------------------
log "upgrading pip"
pip_sys --upgrade pip wheel >/dev/null

# supervisor runs the process tree; pinned in requirements.pod-system.txt.
log "installing supervisor (process manager)"
pip_sys supervisor

# Per-service requirements for everything that runs on the SYSTEM interpreter.
# avatar-video is intentionally excluded: its FastAPI app is light (it only
# shells out to the echomimic venv), and its requirements.txt drags in the
# EchoMimicV3 stack we keep isolated in step 4. We still install avatar-video's
# *light* server deps explicitly below.
for svc in avatar-build image-gen voice finishing realtime; do
    req="${GPU_DIR}/${svc}/requirements.txt"
    if [[ -f "${req}" ]]; then
        log "installing ${svc}/requirements.txt (system)"
        pip_sys -r "${req}"
    else
        warn "missing ${req}"
    fi
done

# avatar-video FastAPI app deps only (NOT the EchoMimicV3 block — that's the venv).
log "installing avatar-video server deps (system, light)"
pip_sys 'fastapi>=0.115' 'uvicorn[standard]>=0.30' 'pydantic>=2.8' \
    'numpy>=1.26' 'torch>=2.4' 'torchvision>=0.19' \
    'opencv-python-headless>=4.10' 'ffmpeg-python>=0.2'

# 3) las_common as an editable install so `import las_common` resolves anywhere.
log "editable install: las_common"
pip_sys -e "${GPU_DIR}/common"

# System-wide pins (see POD_SETUP.md §1). coqui-tts (voice + realtime XTTS)
# needs a modern transformers; diffusers/accelerate are kept at the
# EchoMimic-compatible versions; coqui-tts also needs a recent ml_dtypes.
log "applying system interpreter pins (transformers/diffusers/accelerate/ml_dtypes)"
pip_sys 'transformers==4.57.6' 'diffusers==0.31.0' 'accelerate==0.34.2' 'ml_dtypes>=0.5.4'

# -----------------------------------------------------------------------------
# 4) Isolated EchoMimicV3 venv (premium + flash talking-head inference)
#    Inherits system site-packages (torch 2.4.1+cu124 + CUDA libs) so it doesn't
#    re-download multi-GB GPU wheels, then overrides the 3 conflicting libs and
#    installs avatar-video's EchoMimicV3 runtime requirements.
# -----------------------------------------------------------------------------
EM_PY="${ECHOMIMIC_VENV}/bin/python"
if [[ ! -x "${EM_PY}" ]]; then
    log "creating EchoMimicV3 venv at ${ECHOMIMIC_VENV} (--system-site-packages)"
    "${PY}" -m venv --system-site-packages "${ECHOMIMIC_VENV}"
fi
"${EM_PY}" -m pip install --upgrade pip wheel >/dev/null
log "installing EchoMimicV3 venv pins (diffusers 0.31.0 / transformers 4.49.0 / accelerate 0.34.2)"
"${EM_PY}" -m pip install 'diffusers==0.31.0' 'transformers==4.49.0' 'accelerate==0.34.2'
log "installing avatar-video/requirements.txt into the EchoMimicV3 venv"
"${EM_PY}" -m pip install -r "${GPU_DIR}/avatar-video/requirements.txt"
# onnx in the EchoMimicV3 stack needs float4_e2m1fn, which only exists in
# ml_dtypes>=0.5.4. Pin it LAST so no transitive requirement (e.g. a stray
# tensorflow pulling ml-dtypes~=0.2.0) can clobber it after the fact — the
# requirements install above must not win this version race.
log "pinning ml_dtypes==0.5.4 in the EchoMimicV3 venv (onnx float4_e2m1fn)"
"${EM_PY}" -m pip install 'ml_dtypes==0.5.4'

# -----------------------------------------------------------------------------
# 5) torchvision functional_tensor shim + basicsr patch (finishing service)
#    torchvision>=0.19 removed transforms.functional_tensor, but basicsr (1.4.2),
#    gfpgan and realesrgan all `from torchvision.transforms.functional_tensor
#    import rgb_to_grayscale`. Re-export it as a shim module so EVERY consumer
#    resolves (not just the one basicsr file the sed below rewrites), then keep
#    the basicsr sed as belt-and-suspenders. Both are idempotent.
# -----------------------------------------------------------------------------
install_functional_tensor_shim() {  # $1 = python interpreter
    local interp="$1"
    if "${interp}" -c 'import torchvision.transforms.functional_tensor' >/dev/null 2>&1; then
        return 0  # already importable (native module on older tv, or shim from a prior run)
    fi
    local tv_transforms_dir
    tv_transforms_dir="$("${interp}" -c 'import torchvision.transforms as t, os; print(os.path.dirname(t.__file__))' 2>/dev/null || true)"
    if [[ -z "${tv_transforms_dir}" ]]; then
        return 0  # torchvision not installed for this interpreter
    fi
    log "installing torchvision.transforms.functional_tensor shim (${interp})"
    cat > "${tv_transforms_dir}/functional_tensor.py" <<'PYSHIM'
"""Compatibility shim for torchvision>=0.19, which removed
transforms.functional_tensor. basicsr/gfpgan/realesrgan still import
rgb_to_grayscale from this module path, so re-export it from functional."""
from torchvision.transforms.functional import rgb_to_grayscale  # noqa: F401
PYSHIM
}

patch_basicsr() {  # $1 = python interpreter
    local interp="$1"
    local basicsr_dir
    basicsr_dir="$("${interp}" -c 'import basicsr, os; print(os.path.dirname(basicsr.__file__))' 2>/dev/null || true)"
    if [[ -z "${basicsr_dir}" ]]; then
        return 0  # basicsr not installed for this interpreter
    fi
    local degr="${basicsr_dir}/data/degradations.py"
    if [[ -f "${degr}" ]] && grep -q 'functional_tensor import rgb_to_grayscale' "${degr}"; then
        log "patching basicsr functional_tensor import (${interp})"
        sed -i 's/from torchvision.transforms.functional_tensor import rgb_to_grayscale/from torchvision.transforms.functional import rgb_to_grayscale/' "${degr}"
    fi
}

# Finishing runs on the system interpreter (see supervisord.conf), so the shim +
# patch land in the system site-packages it imports from.
install_functional_tensor_shim "${PY}"
patch_basicsr "${PY}"

# -----------------------------------------------------------------------------
# 6) sk-video + numpy>=1.24 patch (Practical-RIFE inference_video.py dep)
#    sk-video uses removed np.float/np.int/np.bool/np.object aliases.
# -----------------------------------------------------------------------------
if ! "${PY}" -c "import skvideo" 2>/dev/null; then
    log "installing sk-video"
    pip_sys sk-video
fi
SK="$("${PY}" -c 'import skvideo,os;print(os.path.dirname(skvideo.__file__))' 2>/dev/null || true)"
if [[ -n "${SK}" ]]; then
    if grep -rEl 'np\.(float|int|bool|object)([^0-9a-zA-Z_])' "${SK}" >/dev/null 2>&1; then
        log "patching sk-video removed numpy aliases"
        grep -rEl 'np\.(float|int|bool|object)([^0-9a-zA-Z_])' "${SK}" | while read -r f; do
            sed -i -E 's/np\.float([^0-9a-zA-Z_])/float\1/g; s/np\.int([^0-9a-zA-Z_])/int\1/g; s/np\.bool([^0-9a-zA-Z_])/bool\1/g; s/np\.object([^0-9a-zA-Z_])/object\1/g' "${f}"
        done
    fi
fi

# -----------------------------------------------------------------------------
# 7) (optional) MuseTalk realtime venv — needs the MuseTalk repo cloned first.
# -----------------------------------------------------------------------------
if [[ "${SETUP_MUSETALK:-0}" == "1" ]]; then
    if [[ -d "${WORKSPACE}/repos/MuseTalk/.git" ]]; then
        log "SETUP_MUSETALK=1 -> running setup_musetalk.sh"
        bash "${SCRIPT_DIR}/setup_musetalk.sh"
    else
        warn "SETUP_MUSETALK=1 but ${WORKSPACE}/repos/MuseTalk not cloned yet; run seed_weights.sh first, then setup_musetalk.sh"
    fi
fi

log "done. System interpreter + EchoMimicV3 venv ready."
log "next: set pod.env, run seed_weights.sh (weights), setup_musetalk.sh (realtime), then start.sh"
