#!/usr/bin/env bash
# Fetch avatars into their per-avatar folders (public/<id>-model/model.glb).
#
# All from the MIT-licensed met4citizen/talkinghead repo (avatars are generated /
# large, kept out of git, fetched on demand). Each folder's config.json IS
# committed, so the dropdown lists every avatar and a fresh checkout works on the
# two committed models (brunette-model, facecap-model) before fetching.
#
# Add your own: drop public/<name>-model/{model.glb,config.json} — auto-discovered
# (see AVATARS.md). Avaturn exports must be Type-2 (T2) or they have no blendshapes.
set -euo pipefail
cd "$(dirname "$0")/../public"
base="https://raw.githubusercontent.com/met4citizen/talkinghead/main/avatars"
fetch() { mkdir -p "$1-model"; echo "→ $1"; curl -fsSL -o "$1-model/model.glb" "$base/$2"; }
fetch avaturn     avaturn.glb      # photoreal (T2)
fetch avatarsdk   avatarsdk.glb    # photoreal
fetch mpfb        mpfb.glb         # realistic, CC0 (large, ~36MB)
fetch vroid       vroid.glb        # stylized
fetch brunette-t  brunette-t.glb   # RPM lite variant
echo "Fetched avatars into $(pwd)"
