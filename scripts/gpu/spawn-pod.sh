#!/usr/bin/env bash
# spawn-pod.sh — idempotently provision the LiveAvatarStream GPU plane:
# a persistent RunPod H100 pod + a ~300GB network volume, with SSH (22/tcp)
# and the nginx gateway (8080/http) exposed. Safe to re-run: it reuses an
# existing volume named $VOLUME_NAME and an existing pod named $POD_NAME.
#
# Reads RUNPOD_API_KEY and the LAS GPU env contract from the environment,
# falling back to projects/LiveAvatarStream/.env if present.
#
# H100 availability is scarce; the pod is pinned to the volume's datacenter,
# so the volume MUST live in a datacenter that currently has H100 stock.
# This run provisioned into EUR-IS-3 (H100 80GB HBM3 was the only datacenter
# with non-"Low" stock at provisioning time). Override VOLUME_DC to change.
#
# Usage:
#   ./scripts/gpu/spawn-pod.sh              # provision (or report existing)
#   VOLUME_DC=US-GA-2 ./scripts/gpu/spawn-pod.sh
#   ./scripts/gpu/spawn-pod.sh --info       # just print connection details
#
set -euo pipefail

log()  { printf '[spawn-pod %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

REST="https://rest.runpod.io/v1"

# --- locate + load .env (env vars already set take precedence) -----------
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

: "${RUNPOD_API_KEY:?RUNPOD_API_KEY is required}"

# --- tunables ------------------------------------------------------------
VOLUME_NAME="${VOLUME_NAME:-las-models}"
VOLUME_SIZE_GB="${VOLUME_SIZE_GB:-300}"
VOLUME_DC="${VOLUME_DC:-EUR-IS-3}"        # datacenter for a *new* volume
POD_NAME="${POD_NAME:-las-h100}"
IMAGE="${IMAGE:-runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04}"
CONTAINER_DISK_GB="${CONTAINER_DISK_GB:-80}"
# Preferred H100 first, then fallbacks. Pod is pinned to the volume's DC,
# so only GPUs actually stocked there can be allocated.
GPU_TYPE_IDS_JSON="${GPU_TYPE_IDS_JSON:-[\"NVIDIA H100 NVL\",\"NVIDIA H100 PCIe\",\"NVIDIA H100 80GB HBM3\"]}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/las_runpod}"

api() { curl -sS -m 30 -H "Authorization: Bearer ${RUNPOD_API_KEY}" "$@"; }

report() {  # $1 = pod id
  api "${REST}/pods/$1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
pid=d['id']
gpu=(d.get('machine') or {}).get('gpuTypeId') or ','.join(d.get('gpuTypeIds') or [])
ip=d.get('publicIp','')
pm=d.get('portMappings') or {}
ssh_port=pm.get('22')
print('========================================')
print('POD_ID           :', pid)
print('NAME             :', d.get('name'))
print('GPU              :', gpu)
print('COST_PER_HR      : \$%s' % d.get('costPerHr'))
print('STATUS           :', d.get('desiredStatus'))
print('GATEWAY_URL      : https://%s-8080.proxy.runpod.net' % pid)
print('PUBLIC_IP        :', ip)
if ssh_port:
    print('SSH (direct)     : ssh -i ~/.ssh/las_runpod -p %s root@%s' % (ssh_port, ip))
print('SSH (proxy alt)  : ssh %s@ssh.runpod.io -i ~/.ssh/las_runpod' % pid)
print('NETWORK_VOLUME   : %s  (mounted at /workspace)' % d.get('networkVolumeId'))
print('========================================')
"
}

# --info: just report the existing pod and exit
if [[ "${1:-}" == "--info" ]]; then
  PID="$(api "${REST}/pods" | POD_NAME="$POD_NAME" python3 -c "
import json,sys,os
name=os.environ['POD_NAME']
pods=json.load(sys.stdin)
pods=pods if isinstance(pods,list) else pods.get('pods',pods.get('data',[]))
print(next((p['id'] for p in pods if p.get('name')==name), ''))")"
  [[ -n "${PID}" ]] || die "no pod named '${POD_NAME}' found"
  report "${PID}"; exit 0
fi

# --- SSH keypair ---------------------------------------------------------
if [[ ! -f "${SSH_KEY}" ]]; then
  log "generating ed25519 keypair at ${SSH_KEY}"
  ssh-keygen -t ed25519 -N "" -C "las_runpod" -f "${SSH_KEY}" >/dev/null
fi
PUBLIC_KEY="$(cat "${SSH_KEY}.pub")"

# --- find or create network volume --------------------------------------
log "looking for network volume '${VOLUME_NAME}'"
VOL_JSON="$(api "${REST}/networkvolumes")"
read -r VOL_ID DC_ID < <(printf '%s' "$VOL_JSON" | VOLUME_NAME="$VOLUME_NAME" VOLUME_SIZE_GB="$VOLUME_SIZE_GB" python3 -c "
import json,sys,os
want=os.environ['VOLUME_NAME']; need=int(os.environ['VOLUME_SIZE_GB'])
vols=json.load(sys.stdin)
m=[v for v in vols if v.get('name')==want and int(v.get('size',0))>=need]
if not m: m=[v for v in vols if int(v.get('size',0))>=need]
if m: print(m[0]['id'], m[0]['dataCenterId'])
")
if [[ -z "${VOL_ID:-}" ]]; then
  log "creating ${VOLUME_SIZE_GB}GB volume '${VOLUME_NAME}' in ${VOLUME_DC}"
  CREATE="$(api -X POST -H 'Content-Type: application/json' "${REST}/networkvolumes" \
      -d "{\"name\":\"${VOLUME_NAME}\",\"size\":${VOLUME_SIZE_GB},\"dataCenterId\":\"${VOLUME_DC}\"}")"
  VOL_ID="$(printf '%s' "$CREATE" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')"
  [[ -n "${VOL_ID}" ]] || die "volume create failed: ${CREATE}"
  DC_ID="${VOLUME_DC}"
fi
log "volume id=${VOL_ID} datacenter=${DC_ID}"

# --- reuse existing pod if present ---------------------------------------
EXIST="$(api "${REST}/pods" | POD_NAME="$POD_NAME" python3 -c "
import json,sys,os
name=os.environ['POD_NAME']
pods=json.load(sys.stdin)
pods=pods if isinstance(pods,list) else pods.get('pods',pods.get('data',[]))
for p in pods:
    if p.get('name')==name and p.get('desiredStatus','') not in ('TERMINATED',):
        print(p['id']); break
")"
if [[ -n "${EXIST}" ]]; then
  POD_ID="${EXIST}"
  log "reusing existing pod '${POD_NAME}' id=${POD_ID}"
else
  log "creating pod '${POD_NAME}' image=${IMAGE} dc=${DC_ID}"
  PAYLOAD="$(PUBLIC_KEY="$PUBLIC_KEY" POD_NAME="$POD_NAME" IMAGE="$IMAGE" \
      CONTAINER_DISK_GB="$CONTAINER_DISK_GB" VOL_ID="$VOL_ID" DC_ID="$DC_ID" \
      GPU_TYPE_IDS_JSON="$GPU_TYPE_IDS_JSON" python3 -c "
import json,os
env={
  'PUBLIC_KEY': os.environ['PUBLIC_KEY'],
  'R2_ACCOUNT_ID': os.environ.get('R2_ACCOUNT_ID',''),
  'R2_ACCESS_KEY_ID': os.environ.get('R2_ACCESS_KEY_ID',''),
  'R2_SECRET_ACCESS_KEY': os.environ.get('R2_SECRET_ACCESS_KEY',''),
  'R2_ENDPOINT': os.environ.get('R2_ENDPOINT',''),
  'R2_ASSETS_BUCKET': os.environ.get('R2_ASSETS_BUCKET','las-assets'),
  'R2_AVATARS_BUCKET': os.environ.get('R2_AVATARS_BUCKET','las-avatars'),
  'R2_VOICES_BUCKET': os.environ.get('R2_VOICES_BUCKET','las-voices'),
  'R2_OUTPUTS_BUCKET': os.environ.get('R2_OUTPUTS_BUCKET','las-outputs'),
  'CONTROL_API_URL': os.environ.get('CONTROL_API_URL',''),
  'INTERNAL_SERVICE_TOKEN': os.environ.get('INTERNAL_SERVICE_TOKEN',''),
  'HF_TOKEN': os.environ.get('HF_TOKEN',''),
  'MODEL_CACHE_DIR': '/workspace/.model_cache',
  'HF_HOME': '/workspace/.model_cache',
  'TALKING_HEAD_ROOT': '/workspace/repos/echomimic_v3',
  'COQUI_TOS_AGREED': '1',
}
body={
  'cloudType':'SECURE',
  'name': os.environ['POD_NAME'],
  'imageName': os.environ['IMAGE'],
  'containerDiskInGb': int(os.environ['CONTAINER_DISK_GB']),
  'volumeInGb': 0,
  'interruptible': False,
  'supportPublicIp': True,
  'computeType':'GPU',
  'gpuCount': 1,
  'gpuTypeIds': json.loads(os.environ['GPU_TYPE_IDS_JSON']),
  'gpuTypePriority':'availability',
  'allowedCudaVersions':['12.4','12.5','12.6','12.7','12.8'],
  'networkVolumeId': os.environ['VOL_ID'],
  'volumeMountPath':'/workspace',
  'dataCenterIds':[os.environ['DC_ID']],
  'ports':['8080/http','22/tcp'],
  'env': env,
}
print(json.dumps(body))
")"
  RESP="$(api -X POST -H 'Content-Type: application/json' "${REST}/pods" -d "${PAYLOAD}")"
  POD_ID="$(printf '%s' "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')"
  [[ -n "${POD_ID}" ]] || die "pod create returned no id (no H100 capacity in ${DC_ID}?): ${RESP}"
  log "created pod id=${POD_ID}"
fi

# --- poll until the SSH port is mapped (REST has no 'runtime' field) ------
log "waiting for pod ${POD_ID} SSH port to map"
for i in $(seq 1 60); do
  P="$(api "${REST}/pods/${POD_ID}")"
  STATUS="$(printf '%s' "$P" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("desiredStatus",""))')"
  SSHP="$(printf '%s' "$P" | python3 -c 'import json,sys;print((json.load(sys.stdin).get("portMappings") or {}).get("22",""))')"
  log "  status=${STATUS} ssh_port=${SSHP:-pending} (poll ${i})"
  [[ "${STATUS}" == "RUNNING" && -n "${SSHP}" ]] && break
  sleep 10
done

report "${POD_ID}"
printf '%s\n' "${POD_ID}" > /tmp/las-last-pod.txt
