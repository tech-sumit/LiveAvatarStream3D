#!/usr/bin/env bash
# Fetch photoreal avatars into their per-avatar folders (public/<id>-model/model.glb).
#
# Sourced from the MIT-licensed met4citizen/talkinghead repo. These avatars are
# generated (Avaturn / Avatar SDK) and kept out of git (size + generated-asset
# terms), so they're fetched on demand. brunette-model + facecap-model ship their
# model.glb committed as always-available fallbacks; every avatar's config.json is
# committed too, so the dropdown lists all of them and a fresh checkout still works.
#
# Add your own avatar: drop a folder public/<name>-model/ with model.glb +
# config.json — it's auto-discovered (see AVATARS.md), no code change needed.
set -euo pipefail
cd "$(dirname "$0")/../public"
base="https://raw.githubusercontent.com/met4citizen/talkinghead/main/avatars"
mkdir -p avaturn-model avatarsdk-model
curl -fsSL -o avaturn-model/model.glb   "$base/avaturn.glb"
curl -fsSL -o avatarsdk-model/model.glb "$base/avatarsdk.glb"
echo "Fetched avaturn-model/model.glb + avatarsdk-model/model.glb into $(pwd)"
