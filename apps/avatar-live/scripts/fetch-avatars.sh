#!/usr/bin/env bash
# Fetch photoreal avatars (Avaturn, Avatar SDK) into public/avatars/.
#
# Sourced from the MIT-licensed met4citizen/talkinghead repo. The avatars
# themselves are generated (Avaturn / Avatar SDK); they're kept out of git (size
# + generated-asset terms) and fetched on demand. brunette.glb (stylized RPM) and
# human.glb (facecap) are committed as always-available fallbacks.
set -euo pipefail
cd "$(dirname "$0")/../public/avatars"
base="https://raw.githubusercontent.com/met4citizen/talkinghead/main/avatars"
curl -fsSL -o avaturn.glb   "$base/avaturn.glb"
curl -fsSL -o avatarsdk.glb "$base/avatarsdk.glb"
echo "Fetched avaturn.glb + avatarsdk.glb into $(pwd)"
