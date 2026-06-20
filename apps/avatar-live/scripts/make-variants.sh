#!/usr/bin/env bash
# Regenerate the Avaturn-based anchor variants from the avaturn base.
# Needs: public/avaturn-model/model.glb (run fetch-avatars.sh first) + Blender.
# The variant GLBs are gitignored; their config.json is committed, so this script
# rebuilds the binaries. Each keeps avaturn's rig + ARKit blendshapes — only the
# hair / skin / outfit are recolored (see scripts/avatar-variant.py).
set -euo pipefail
cd "$(dirname "$0")/.."
BL="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
base="public/avaturn-model/model.glb"
[ -f "$base" ] || { echo "missing $base — run scripts/fetch-avatars.sh first"; exit 1; }

"$BL" -b --python scripts/avatar-variant.py -- "$base" \
  public/avaturn-anchor2-model/model.glb \
  --hair 0.10,0.08,0.07 --outfit 0.18,0.24,0.45 --skin 0.80,0.60,0.46   # dark hair / navy / deeper skin

"$BL" -b --python scripts/avatar-variant.py -- "$base" \
  public/avaturn-anchor3-model/model.glb \
  --hair 0.86,0.70,0.40 --outfit 0.55,0.12,0.18 --skin 0.98,0.90,0.84   # auburn-blonde / burgundy / fair

echo "regenerated avaturn-anchor2 + avaturn-anchor3"
