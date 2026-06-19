#!/usr/bin/env bash
# health-roundtrip.sh — verify the GPU plane is reachable, two ways:
#
#   1) DIRECT: GET ${GPU_PROVIDER_BASE_URL}/avatar-build/health and
#      ${GPU_PROVIDER_BASE_URL}/engine-three/health straight at the pod gateway
#      (proves the pod + nginx + core services are up).
#   2) WORKER: POST /api/_health/gpu on the deployed control-api, then poll the
#      job until it succeeds (proves the *deployed Worker* can reach the pod and
#      write a round-trip marker into R2 OUTPUTS — the Phase 0 round-trip proof).
#
# Mirrors the env-loading convention of scripts/gpu/spawn-pod.sh: values already
# in the environment win; otherwise we read projects/LiveAvatarStream/.env.
#
# Usage:
#   ./scripts/gpu/health-roundtrip.sh              # both checks
#   ./scripts/gpu/health-roundtrip.sh --direct     # pod gateway only
#   ./scripts/gpu/health-roundtrip.sh --worker     # deployed Worker round-trip only
#
# Env:
#   GPU_PROVIDER_BASE_URL  pod gateway, e.g. https://<podId>-8080.proxy.runpod.net
#   GPU_PROVIDER_TOKEN     bearer token the Worker presents to the gateway (optional)
#   CONTROL_API_URL        deployed Worker base URL, e.g. https://las-control-api.<acct>.workers.dev
set -euo pipefail

log() { printf '[health %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # -> projects/LiveAvatarStream
ENV_FILE="${LAS_ENV_FILE:-${HERE}/.env}"
if [[ -f "${ENV_FILE}" ]]; then
  log "loading env from ${ENV_FILE}"
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -n "${!k:-}" ]] && continue
    v="${v%$'\r'}"
    export "$k=$v"
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "${ENV_FILE}" | sed 's/[[:space:]]*#.*$//' | sed 's/[[:space:]]*$//')
fi

MODE="${1:-both}"

check_direct() {
  : "${GPU_PROVIDER_BASE_URL:?GPU_PROVIDER_BASE_URL is required for the direct check}"
  local auth=()
  [[ -n "${GPU_PROVIDER_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer ${GPU_PROVIDER_TOKEN}")

  local url="${GPU_PROVIDER_BASE_URL%/}/avatar-build/health"
  log "DIRECT  GET ${url}"
  local code
  code="$(curl -sS -o /tmp/las-health-direct.txt -w '%{http_code}' -m 30 "${auth[@]+"${auth[@]}"}" "${url}")"
  log "DIRECT  avatar-build -> HTTP ${code}; body: $(cat /tmp/las-health-direct.txt)"
  [[ "${code}" == "200" ]] || die "pod gateway avatar-build health failed (HTTP ${code})"

  url="${GPU_PROVIDER_BASE_URL%/}/engine-three/health"
  log "DIRECT  GET ${url}"
  code="$(curl -sS -o /tmp/las-health-engine-three.txt -w '%{http_code}' -m 30 "${auth[@]+"${auth[@]}"}" "${url}")"
  log "DIRECT  engine-three -> HTTP ${code}; body: $(cat /tmp/las-health-engine-three.txt)"
  [[ "${code}" == "200" ]] || die "pod gateway engine-three health failed (HTTP ${code})"

  log "DIRECT  OK"
}

check_worker() {
  : "${CONTROL_API_URL:?CONTROL_API_URL is required for the worker round-trip}"
  local api="${CONTROL_API_URL%/}"
  log "WORKER  POST ${api}/api/_health/gpu"
  local job_id
  job_id="$(curl -sS -m 30 -X POST "${api}/api/_health/gpu" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin).get("jobId",""))')"
  [[ -n "${job_id}" ]] || die "no jobId returned from /api/_health/gpu"
  log "WORKER  job=${job_id}; polling"
  for i in $(seq 1 30); do
    local status
    status="$(curl -sS -m 30 "${api}/api/jobs/${job_id}" \
      | python3 -c 'import json,sys;print((json.load(sys.stdin).get("job") or {}).get("status",""))')"
    log "  status=${status:-?} (poll ${i})"
    [[ "${status}" == "succeeded" ]] && { log "WORKER  OK (round-trip marker written to R2)"; return 0; }
    [[ "${status}" == "failed" ]] && die "worker round-trip failed (the Worker could not reach the pod)"
    sleep 4
  done
  die "worker round-trip timed out"
}

case "${MODE}" in
  --direct) check_direct ;;
  --worker) check_worker ;;
  both|"") check_direct; check_worker ;;
  *) die "unknown mode '${MODE}' (use --direct | --worker | both)" ;;
esac

log "PASS"
