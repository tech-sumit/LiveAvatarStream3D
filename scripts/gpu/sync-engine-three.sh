#!/usr/bin/env bash
# sync-engine-three.sh — push local engine-three build + avatar assets to the H100 pod.
#
# The editor compiles manifests with manifest.scene (WYSIWYG camera + layout).
# The pod must run a matching engine-three build or renders fall back to the
# legacy cinematic camera + procedural placeholder figure.
#
# Usage:
#   POD_SSH='root@ssh.runpod.io' ./scripts/gpu/sync-engine-three.sh
#   POD_SSH='root@1.2.3.4' POD_SSH_PORT=12345 ./scripts/gpu/sync-engine-three.sh
#
# After sync, verify:
#   curl -s "$GPU_PROVIDER_BASE_URL/engine-three/health" | python3 -m json.tool
#   # expect wysiwygScene: true, leePerrySmithLoaded: true
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENGINE_DIR="${ROOT}/services/engine-three"
POD_ROOT="${POD_LAS_ROOT:-/workspace/las}"
POD_ENGINE="${POD_ROOT}/services/engine-three"

log() { printf '[sync-engine-three] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

: "${POD_SSH:?Set POD_SSH (e.g. root@213.181.105.227)}"
POD_SSH_PORT="${POD_SSH_PORT:-}"
SSH_KEY="${LAS_SSH_KEY:-${HOME}/.ssh/las_runpod}"
RSYNC_SSH=(ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new)
[[ -n "${POD_SSH_PORT}" ]] && RSYNC_SSH+=(-p "${POD_SSH_PORT}")

log "building @las/protocol + @las/engine-three"
(cd "${ROOT}" && npm run build --workspace @las/protocol --workspace @las/engine-three)

# Keep engine-three assets in sync with editor bundles (Lee bust + mouth decal).
LEE_SRC="${ROOT}/apps/scene-editor/public/avatars/LeePerrySmith"
LEE_DST="${ENGINE_DIR}/assets/avatars/LeePerrySmith"
DECAL_SRC="${ROOT}/apps/scene-editor/public/avatars/decal-diffuse.png"
if [[ -d "${LEE_SRC}" ]]; then
  mkdir -p "${LEE_DST}"
  rsync -a "${LEE_SRC}/" "${LEE_DST}/"
fi
if [[ -f "${DECAL_SRC}" ]]; then
  cp -f "${DECAL_SRC}" "${ENGINE_DIR}/assets/avatars/decal-diffuse.png"
fi

log "uploading dist + assets to ${POD_SSH}:${POD_ENGINE}"
if command -v rsync >/dev/null && "${RSYNC_SSH[@]}" "${POD_SSH}" "command -v rsync" >/dev/null 2>&1; then
  rsync -avz -e "${RSYNC_SSH[*]}" \
    "${ENGINE_DIR}/dist/" "${POD_SSH}:${POD_ENGINE}/dist/"
  rsync -avz -e "${RSYNC_SSH[*]}" \
    "${ENGINE_DIR}/assets/" "${POD_SSH}:${POD_ENGINE}/assets/"
  rsync -avz -e "${RSYNC_SSH[*]}" \
    "${ENGINE_DIR}/package.json" "${POD_SSH}:${POD_ENGINE}/package.json"
else
  log "rsync unavailable on pod — using tar over ssh"
  COPYFILE_DISABLE=1 tar -C "${ENGINE_DIR}" --no-xattrs -czf - dist assets package.json 2>/dev/null | \
    "${RSYNC_SSH[@]}" "${POD_SSH}" "mkdir -p ${POD_ENGINE} && tar --no-same-owner -xzf - -C ${POD_ENGINE}"
fi

log "restarting engine-three on pod"
"${RSYNC_SSH[@]}" "${POD_SSH}" "supervisorctl restart engine-three || (cd ${POD_ROOT}/services/gpu/deploy && bash start.sh)"

log "done — check health:"
log "  curl -s \"\${GPU_PROVIDER_BASE_URL:-https://<pod>-8080.proxy.runpod.net}/engine-three/health\""
