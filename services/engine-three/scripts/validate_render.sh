#!/usr/bin/env bash
# Local render validation — requires headless-gl (Linux GPU pod or native gl build).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}/services/engine-three"

FIXTURES="${ROOT}/services/engine-three/assets/fixtures"
MANIFEST="${FIXTURES}/poc_manifest.json"
OUT="${1:-./out}"

if [[ ! -f "${FIXTURES}/silence.wav" ]]; then
  echo "Generating silence.wav..."
  ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=mono -t 5 "${FIXTURES}/silence.wav" >/dev/null 2>&1
fi

export RENDER_PROFILE=dev
npm run render:local -- "${MANIFEST}" "${FIXTURES}/silence.wav" "${OUT}"

MP4=$(find "${OUT}" -name '*.mp4' | head -1)
if [[ -z "${MP4}" ]]; then
  echo "FAIL: no mp4 produced"
  exit 1
fi

ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${MP4}"
echo "OK: ${MP4}"
