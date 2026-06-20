#!/usr/bin/env bash
# Fetch the Avaturn base avatar, then rebuild the recolor variants from it.
#
# Avaturn (the photoreal, RPM-compatible base) is from the MIT met4citizen/
# talkinghead repo — large, gitignored, fetched on demand. Each avatar's
# config.json IS committed, so the dropdown lists them; this restores the binaries.
# Avaturn exports must be Type-2 (T2) or they have no blendshapes.
#
# Add your own: drop public/<name>-model/{model.glb,config.json} (auto-discovered),
# or recolor avaturn into a new anchor with scripts/avatar-variant.py (see AVATARS.md).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/../public"
base="https://raw.githubusercontent.com/met4citizen/talkinghead/main/avatars"
mkdir -p avaturn-model
echo "→ avaturn"
curl -fsSL -o avaturn-model/model.glb "$base/avaturn.glb"
echo "Fetched avaturn. Rebuilding recolor variants…"
bash "$DIR/make-variants.sh" || echo "(variants need Blender — run scripts/make-variants.sh manually)"
echo "Done."
