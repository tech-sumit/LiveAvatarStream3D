#!/usr/bin/env bash
# Fetch Ready Player Me body-animation clips into public/animations/.
#
# These are NOT committed: the RPM Animation Library license permits free use
# (incl. commercial) *with Ready Player Me avatars* but prohibits redistribution.
# So we download them on demand instead of bundling them in the repo.
#
# The clips are real Mixamo mocap retargeted to the RPM skeleton, so they bind to
# our RPM/Avaturn avatars directly (rotation-only, by bone name — see
# avatarController.loadAnimations). The "expression/M_Standing_Expressions_*" set
# are short standing gestures; each is mapped below to a DSL gesture (see
# src/avatar/gestures.ts GESTURE_CLIPS).
set -euo pipefail
cd "$(dirname "$0")/../public/animations"
base="https://raw.githubusercontent.com/readyplayerme/animation-library/master/feminine/glb"

# Idle + talking-variation body clips (the speaking/idle base motion).
curl -fsSL -o idle.glb      "$base/idle/F_Standing_Idle_001.glb"
curl -fsSL -o idle_calm.glb "$base/idle/F_Standing_Idle_Variations_002.glb"
curl -fsSL -o talk1.glb     "$base/expression/F_Talking_Variations_001.glb"
curl -fsSL -o talk2.glb     "$base/expression/F_Talking_Variations_002.glb"
curl -fsSL -o talk3.glb     "$base/expression/F_Talking_Variations_003.glb"
curl -fsSL -o talk4.glb     "$base/expression/F_Talking_Variations_004.glb"
curl -fsSL -o talk5.glb     "$base/expression/F_Talking_Variations_005.glb"

# Dedicated gesture clips, curated for a FORMAL, upright, professional-anchor look
# (good posture, composed — the slouching/leaning/big-casual clips are deliberately
# avoided). The feminine library only ships "talking variations" (which are our talk
# clips), so distinct gestures are sourced from the upright M_Standing_Expressions
# plus the one free feminine clip (F_Talking_Variations_006 → shrug).
curl -fsSL -o open_palms.glb    "$base/expression/M_Standing_Expressions_005.glb"  # arms open, presenting
curl -fsSL -o hand_to_chest.glb "$base/expression/M_Standing_Expressions_004.glb"  # sincere, hands to chest
curl -fsSL -o nod.glb           "$base/expression/M_Standing_Expressions_014.glb"  # composed head acknowledge
curl -fsSL -o shrug.glb         "$base/expression/F_Talking_Variations_006.glb"    # feminine open-hands "well"
curl -fsSL -o point.glb         "$base/expression/M_Standing_Expressions_002.glb"  # raised hand, indicating
curl -fsSL -o count.glb         "$base/expression/M_Standing_Expressions_010.glb"  # measured enumerate
curl -fsSL -o wave.glb          "$base/expression/M_Standing_Expressions_016.glb"  # restrained raised-hand greeting
curl -fsSL -o thumbs_up.glb     "$base/expression/M_Standing_Expressions_018.glb"  # restrained affirm

echo "Fetched idle + idle_calm + talk1..5 + 8 gesture clips into $(pwd)"
