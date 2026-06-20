#!/usr/bin/env bash
# Fetch Ready Player Me body-animation clips into public/animations/.
#
# These are NOT committed: the RPM Animation Library license permits free use
# (incl. commercial) *with Ready Player Me avatars* but prohibits redistribution.
# So we download them on demand instead of bundling them in the repo.
set -euo pipefail
cd "$(dirname "$0")/../public/animations"
base="https://raw.githubusercontent.com/readyplayerme/animation-library/master/feminine/glb"
curl -fsSL -o idle.glb  "$base/idle/F_Standing_Idle_001.glb"
curl -fsSL -o talk1.glb "$base/expression/F_Talking_Variations_001.glb"
curl -fsSL -o talk2.glb "$base/expression/F_Talking_Variations_002.glb"
curl -fsSL -o talk3.glb "$base/expression/F_Talking_Variations_003.glb"
echo "Fetched idle + talk1..3 into $(pwd)"
