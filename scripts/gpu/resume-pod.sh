#!/usr/bin/env bash
# resume-pod.sh — print (or run via SSH) the post-resume bring-up for the H100 pod.
#
# RunPod wipes the container disk on stop/resume; only /workspace persists.
# After starting a stopped pod, run this sequence ON THE POD (or via SSH):
#
#   ./scripts/gpu/resume-pod.sh --print     # show commands (default)
#   ./scripts/gpu/resume-pod.sh --ssh       # run over SSH (needs POD_SSH)
#
# From your laptop after the pod is running:
#   GPU_PROVIDER_BASE_URL=https://<pod>-8080.proxy.runpod.net \
#     ./scripts/gpu/health-roundtrip.sh --direct
#
set -euo pipefail

log() { printf '[resume-pod] %s\n' "$*" >&2; }

LAS_ROOT="${LAS_POD_ROOT:-/workspace/las}"
POD_SSH="${POD_SSH:-}"

BRINGUP=$(cat <<EOF
set -euo pipefail
set -a; . ${LAS_ROOT}/pod.env; set +a
bash ${LAS_ROOT}/services/gpu/deploy/install_deps.sh
bash ${LAS_ROOT}/services/gpu/deploy/start.sh
EOF
)

print_steps() {
  cat <<EOF
# --- Run on the H100 pod after resume/start ---

${BRINGUP}

# --- Then from your laptop ---

export GPU_PROVIDER_BASE_URL="https://<podId>-8080.proxy.runpod.net"
export CONTROL_API_URL="https://las-control-api.tech-sumit.workers.dev"
./scripts/gpu/health-roundtrip.sh --direct
curl -s "\${GPU_PROVIDER_BASE_URL}/engine-three/health" | python3 -m json.tool

# Full 3D engine e2e (needs Worker deployed with engine_render + pod engine-three):
CONTROL_API_URL="\${CONTROL_API_URL}" \\
  python3 services/gpu/deploy/validate_engine_render.py \\
    --video demo_video.mp4 --out /tmp/engine_poc.mp4
EOF
}

run_ssh() {
  [[ -n "${POD_SSH}" ]] || { log "set POD_SSH=user@host (RunPod SSH target)"; exit 1; }
  log "running bring-up on ${POD_SSH}"
  ssh -o StrictHostKeyChecking=accept-new "${POD_SSH}" "bash -s" <<< "${BRINGUP}"
  log "done — run health-roundtrip from laptop"
}

case "${1:---print}" in
  --print|"") print_steps ;;
  --ssh) run_ssh ;;
  *) log "usage: $0 [--print|--ssh]"; exit 1 ;;
esac
